/**
 * `git_credentials`: a session token (`bss_`) for one repository, at most an hour, no wider
 * than the session (read; push beans with `write`) and the person's access there, revoked
 * with the session's grant. Returned as `git credential approve` input so it goes to git's
 * own credential store and never into a URL, a remote or a file. The gateway's git proxy
 * opens only that repository with it; /mcp refuses it as a bearer.
 *
 * For an address where no repository is yet (`owner/name` not found), a session with read,
 * write and create gets a credential bound to that address (`new:owner/name`), with which a
 * push creates the repository (push-to-create), private.
 *
 * It is visible to the model that asked for it: the trade-off `16` §3.3 accepts until git is
 * connected through setup (SSH keys) on the machine. Logs never carry it.
 */
import { RepoSlug } from '@gitstalk/shared-race/agent-repos';
import { NEW_ADDRESS_PREFIX } from '@gitstalk/shared-race/repo-create';

import type { AgentSessionContext, MintedGitToken, ToolScope } from '../tools/tool-context';
import { ToolError } from '../mcp/tool-result';
import { RepositoryAnswer, parsed } from './agent-gateway';
import { cloneUrl, sessionOf } from './repo-answers';

const DEFAULT_MINUTES = 60;

type Target = { readonly repo: string; readonly gitPath: string; readonly isNew: boolean };

export async function gitCredentials(
  scope: ToolScope,
  input: { readonly repo: string; readonly ttl_minutes?: number | undefined },
): Promise<object> {
  const { session } = scope;
  if (session === undefined) throw new ToolError('git_credentials needs a signed-in agent session');
  const ttlSeconds = (input.ttl_minutes ?? DEFAULT_MINUTES) * 60;
  const found = await targetOf(scope, session, input.repo);
  const minted: MintedGitToken | null = await session.mintGitToken(
    found.kind === 'existing'
      ? { binding: found.engineId, access: found.access, ttlSeconds }
      : { binding: `${NEW_ADDRESS_PREFIX}${found.target.repo}`, access: 'create', ttlSeconds },
  );
  if (minted === null) throw new ToolError('this session has no git scope (read or write)');
  return credentialAnswer(scope, found.target, minted);
}

type Found =
  | {
      readonly kind: 'existing';
      readonly target: Target;
      readonly engineId: string;
      readonly access: 'read' | 'write';
    }
  | { readonly kind: 'new'; readonly target: Target };

/** The repository at `repo`, or, for a session that may create, the empty address. */
async function targetOf(
  scope: ToolScope,
  session: AgentSessionContext,
  repo: string,
): Promise<Found> {
  const { agents, principal } = sessionOf(scope);
  const answer = await agents.agentRepository(principal, repo);
  const mayCreate = ['write', 'create'].every((needed) => session.scopes.some((s) => s === needed));
  const slug = RepoSlug.safeParse(repo);
  if (!answer.ok && answer.error.status === 404 && mayCreate && slug.success)
    return {
      kind: 'new',
      target: { repo: slug.data, gitPath: `/git/${slug.data}.git`, isNew: true },
    };
  const repository = parsed(answer, RepositoryAnswer);
  return {
    kind: 'existing',
    target: { repo: repository.repo, gitPath: repository.git_path, isNew: false },
    engineId: repository.engine_id,
    access: repository.access,
  };
}

function credentialAnswer(scope: ToolScope, target: Target, minted: MintedGitToken): object {
  const url = new URL(cloneUrl(scope, target.gitPath));
  const credential = [
    'protocol=https',
    `host=${url.host}`,
    `path=${url.pathname.replace(/^\//, '')}`,
    'username=x',
    `password=${minted.token}`,
    '',
  ].join('\n');
  const creates = target.isNew
    ? ` No repository is at ${target.repo} yet: pushing main, master, stalk or bean/<name> there with it creates one, private.`
    : '';
  return {
    repo: target.repo,
    clone_url: url.toString(),
    scopes: minted.scopes,
    expires_at: minted.expiresAt,
    credential,
    how: [
      `git config --global credential.https://${url.host}.useHttpPath true   # one token per repository`,
      `git config --global credential.https://${url.host}.helper 'cache --timeout=3600'   # only if no helper is set: memory, not disk`,
      'printf \'%s\\n\' "<credential>" | git credential approve   # the credential field, as is, on stdin',
    ],
    summary: `A ${minted.scopes.join('+')} credential for ${target.repo} until ${minted.expiresAt}. Give it to git credential approve; never print it, write it to a file, put it in a URL or commit it.${creates}`,
  };
}
