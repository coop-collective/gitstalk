/**
 * The account services the web app calls, from its bindings: the MCP Worker's consent and
 * agent-session RPC, and email sign-in (null while this deployment has no sender domain, no
 * EMAIL binding or no EMAIL_SIGNIN_KEY).
 */
import { env } from 'cloudflare:workers';

import type { AgentSessionsRpc } from '@gitstalk/shared-identity/agent-sessions';
import { isAgentSessionsRpc } from '@gitstalk/shared-identity/agent-sessions';
import type { EmailCodeConfig } from '@gitstalk/shared-identity/email-codes';
import { emailCodeConfig } from '@gitstalk/shared-identity/email-codes';
import type { EmailBinding } from '@gitstalk/shared-identity/email';
import { emailServicePort, signInSender } from '@gitstalk/shared-identity/email';

export function agentSessionsRpc(): AgentSessionsRpc {
  const binding: unknown = env.MCP;
  if (!isAgentSessionsRpc(binding))
    throw new Error('the MCP binding does not answer AgentSessionsRpc');
  return binding;
}

/** Email codes (sign-in, Settings → Emails), or null when this deployment cannot send them. */
export function emailSignIn(): EmailCodeConfig | null {
  const domain = env.EMAIL_SENDER_DOMAIN.trim();
  const binding: unknown = Reflect.get(env, 'EMAIL');
  const port =
    domain !== '' && isEmailBinding(binding)
      ? emailServicePort(binding, signInSender(domain))
      : null;
  const key: unknown = Reflect.get(env, 'EMAIL_SIGNIN_KEY');
  return emailCodeConfig({ port, key: typeof key === 'string' ? key : undefined });
}

/** The binding may be missing from an older deployment's config, so it is checked. */
function isEmailBinding(value: unknown): value is EmailBinding {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'send') === 'function'
  );
}
