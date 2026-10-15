/**
 * Git over SSH, the gateway's half (`docs/claude-opus/21-git-over-ssh.md`). The SSH server in
 * the `beanstalk-ssh` Worker's container checks the client's signature, then asks here, over the
 * service binding: whose key is this (`lookupSshKey`), and serve this smart-HTTP request as the
 * key's owner (`serveSshGit`). The request goes through the same `repoGit` as HTTPS, so access
 * (`mayUseEngine`), push = submit, `remote:` verdicts, `-o wait` and refusals are one code path.
 */
import type { GitCredential } from '../auth/git-credential';
import type { SshKeyOwner, SshKeyStore } from '../auth/ssh-keys';
import { sshGitScopes } from '../auth/ssh-keys';
import type { Deps } from '../deps';
import type { RepositoriesDeps } from '../repos/repositories-deps';
import { parseGitPath } from '../git/git-path';
import { repoGit } from '../push/push-proxy';

export type SshDeps = {
  readonly deps: Deps;
  readonly keys: SshKeyStore;
  /** The creation path: a key with `create` may push-to-create, as over HTTPS. */
  readonly repositories?: RepositoriesDeps;
};

/** Whose key a public key line is. `confirm` marks a signature-checked use (the key is touched). */
export type SshKeyLookup = { readonly publicKey: string; readonly confirm: boolean };

export type SshKeyAnswer = { readonly handle: string; readonly fingerprint: string };

/** The key's owner, or null when the line is no key or nobody registered it. */
export async function lookupSshKey(
  input: SshKeyLookup,
  { deps, keys }: SshDeps,
): Promise<SshKeyAnswer | null> {
  const found = await ownerOf(input.publicKey, keys);
  if (found === null) return null;
  if (input.confirm) {
    await keys.touchKey(found.owner.key).catch((error: unknown) => {
      deps.log.warn('ssh key touch failed', { fingerprint: found.fingerprint, error });
    });
    deps.log.info('ssh key used', {
      fingerprint: found.fingerprint,
      handle: found.owner.user.handle,
    });
  }
  return { handle: found.owner.user.handle, fingerprint: found.fingerprint };
}

/** One smart-HTTP request made over SSH with `publicKey`. */
export async function serveSshGit(
  input: { readonly publicKey: string; readonly request: Request },
  { deps, keys, repositories }: SshDeps,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const found = await ownerOf(input.publicKey, keys);
  if (found === null) return text(401, 'this SSH key is not registered to an account');
  const parsed = parseGitPath(new URL(input.request.url), input.request.method);
  if (!parsed.ok) return text(parsed.status, parsed.message);
  if (parsed.path.namespace === deps.config.namespace)
    return text(404, 'race repos are served over HTTPS with their run tokens');
  return repoGit({
    request: input.request,
    path: parsed.path,
    credential: sshCredential(found.owner),
    deps,
    ctx,
    ...(repositories === undefined ? {} : { repositories }),
  });
}

/** A key's owner as a git credential: a person's, bound to no engine (like a personal token). */
function sshCredential(owner: SshKeyOwner): GitCredential {
  return {
    user: owner.user,
    scopes: sshGitScopes(owner),
    engine: null,
    runPrincipal: null,
    session: { via: 'ssh-key', id: owner.key.id },
  };
}

async function ownerOf(
  publicKey: string,
  keys: SshKeyStore,
): Promise<{ owner: SshKeyOwner; fingerprint: string } | null> {
  const owner = await keys.findUserByKey(publicKey);
  return owner === null ? null : { owner, fingerprint: owner.key.fingerprint };
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain' } });
}
