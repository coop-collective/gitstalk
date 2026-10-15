/**
 * The setup script's side of the web app (`/gitstalk:setup` in the Claude Code plugin, or
 * `<web>/setup.sh` for other agents): where git and SSH live for this deployment, and the
 * two calls that register an SSH key (start a request, poll its outcome). Request bodies are
 * validated here; the identity rules live in @gitstalk/shared-identity/ssh-key-requests.
 */
import { z } from 'zod';

import type { KeyRequestPoll, StartedKeyRequest } from '@gitstalk/shared-identity/ssh-key-requests';
import { KEY_REQUEST_POLL_SECONDS } from '@gitstalk/shared-identity/ssh-key-requests';

/** Where the setup script points git, from this deployment's vars. */
export type SetupConfig = {
  readonly web: string;
  readonly git_origin: string;
  /** The SSH endpoint's host, or null until it is live (setup then uses HTTPS and a token). */
  readonly ssh_host: string | null;
  readonly mcp_url: string;
};

export function setupConfig(
  vars: { readonly GIT_ORIGIN: string; readonly MCP_URL: string; readonly SSH_HOST: string },
  webOrigin: string,
): SetupConfig {
  const sshHost = vars.SSH_HOST.trim();
  return {
    web: webOrigin,
    git_origin: vars.GIT_ORIGIN.replace(/\/+$/, ''),
    ssh_host: sshHost === '' ? null : sshHost,
    mcp_url: vars.MCP_URL,
  };
}

export const KeyRequestBody = z.object({
  public_key: z.string().trim().min(20).max(16_384),
  machine: z.string().trim().max(200).default(''),
  https_token: z.boolean().default(false),
  /**
   * What the terminal asks the key and its token may do. Read and write are always granted;
   * `create` (create repositories) is offered on the approval page, ticked by default.
   */
  scopes: z.array(z.string().max(40)).max(10).default([]),
});

/** Whether a key request asks for the `create` scope. */
export function wantsCreate(body: z.infer<typeof KeyRequestBody>): boolean {
  return body.scopes.includes('create');
}

export const PollBody = z.object({ poll_token: z.string().max(100) });

/** The device-style answer to a key request (RFC 8628 field names where they fit). */
export function keyRequestAnswer(started: StartedKeyRequest, webOrigin: string) {
  const verification = `${webOrigin}/settings/keys/add`;
  return {
    user_code: started.userCode,
    poll_token: started.pollToken,
    fingerprint: started.fingerprint,
    verification_uri: verification,
    verification_uri_complete: `${verification}?code=${encodeURIComponent(started.userCode)}`,
    expires_in: started.expiresIn,
    interval: KEY_REQUEST_POLL_SECONDS,
  };
}

/** The poll answer, in the script's snake_case; the HTTPS token appears at most once. */
export function pollAnswer(poll: KeyRequestPoll) {
  if (poll.status !== 'approved') return { status: poll.status };
  return {
    status: poll.status,
    handle: poll.handle,
    ...(poll.httpsToken === null
      ? {}
      : { https_token: poll.httpsToken.token, https_token_expires_at: poll.httpsToken.expiresAt }),
  };
}
