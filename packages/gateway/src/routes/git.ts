/**
 * The git smart-HTTP proxy. Two kinds of URL:
 *
 * - `/git/<namespace>/race-<run>.git/…`: a race's run repo. The run token is checked, the
 *   RunDO decides whether this principal may read or write and which refs, as before.
 * - `/git/<owner>/<repo>.git/…`: a repository's continuous engine (the git-native flow,
 *   `push/push-proxy.ts`): clone and fetch, and push = submit a bean.
 *
 * Either way the request is forwarded to Artifacts with a token the client never sees, and
 * the credential is checked by `verifyGitCredential` alone.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AppEnv } from '../app-env';
import { notConnected } from '../auth/connect-hint';
import { presentedToken } from '../auth/credentials';
import type { GitCredential } from '../auth/git-credential';
import { verifyGitCredential } from '../auth/git-credential';
import { forwardGit } from '../git/forward';
import type { GitPath } from '../git/git-path';
import { accessFor, parseGitPath } from '../git/git-path';
import { inspectPush, pushRefusal } from '../git/receive-pack';
import { repoGit } from '../push/push-proxy';
import { usedFrom } from '../repos/deploy-tokens';
import { repositoriesDepsFrom } from '../repos/repositories-deps';
import { runOfRepo } from '../run/run-names';

const CHALLENGE = { 'www-authenticate': 'Basic realm="gitstalk"' };

export const gitRoutes = new Hono<AppEnv>().all('/*', async (c) => {
  const deps = c.var.deps;
  const parsed = parseGitPath(new URL(c.req.url), c.req.method);
  if (!parsed.ok) return c.text(parsed.message, parsed.status);
  const isRace = parsed.path.namespace === deps.config.namespace;
  const token = presentedToken(c.req.raw);
  if (token === null)
    // A public repository clones without a credential; anything else asks git for one.
    return isRace
      ? c.text('a gitstalk token is required', 401, CHALLENGE)
      : repoGit({
          request: c.req.raw,
          path: parsed.path,
          credential: null,
          deps,
          ctx: c.executionCtx,
        });
  const credential = await verifyGitCredential(
    { ...deps, identity: c.env, forge: c.env.FORGE, usedFrom: usedFrom(c.req.raw) },
    token,
  );
  if (credential === null)
    return isRace
      ? c.text('invalid or expired token', 401, CHALLENGE)
      : notConnected('refused', deps.config.webUrl);
  if (credential.scopes.length === 0) return c.text('this token has no git access', 403);
  if (!isRace) {
    return repoGit({
      request: c.req.raw,
      path: parsed.path,
      credential,
      deps,
      ctx: c.executionCtx,
      repositories: repositoriesDepsFrom(c.env),
    });
  }
  return runGit(c, parsed.path, credential);
});

/** A race's run repo, as the per-run proxy always served it. */
async function runGit(
  c: Context<AppEnv>,
  path: GitPath,
  credential: GitCredential,
): Promise<Response> {
  const principal = credential.runPrincipal;
  if (principal === null) return c.text('this token does not open race repos', 403);
  const run = runOfRepo(path.repo);
  if (run === null || run !== credential.engine)
    return c.text('this token belongs to another run', 403);
  const grant = await c.var.deps
    .run(run)
    .authorizeGit(principal, path.repo, accessFor(path.service));
  if (!grant.ok) return c.text(grant.message, grant.status);
  let body = c.req.raw.body;
  if (path.rest === 'git-receive-pack' && grant.refs !== null) {
    if (c.req.header('content-encoding') !== undefined)
      return c.text('compressed pushes are not supported', 415);
    const inspection = await inspectPush(body);
    if (!inspection.ok) return c.text(inspection.reason, 400);
    const refusal = pushRefusal(inspection.commands, grant.refs);
    if (refusal !== null) return c.text(refusal, 403);
    body = inspection.body;
  }
  return forwardGit(c.req.raw, { upstream: grant.upstream, path, token: grant.token, body });
}
