import { env } from 'cloudflare:workers';

import { clientIp } from '@gitstalk/shared-identity/request-context';
import { getWebSession } from '@gitstalk/shared-identity/sessions';
import { decideKeyRequest } from '@gitstalk/shared-identity/ssh-key-requests';

import { seeOther, signedInForm } from '../../../../../src/auth/http';

/** The "add this SSH key" answer: approve (the key is registered) or deny. */
export async function POST(request: Request): Promise<Response> {
  const checked = await signedInForm(request, (cookies) => getWebSession(cookies, env));
  if (checked instanceof Response) return checked;
  const code = checked.form.get('code');
  if (typeof code !== 'string') return seeOther(request, '/settings/keys/add');
  const decision = checked.form.get('decision') === 'approve' ? 'approve' : 'deny';
  const decided = await decideKeyRequest(env, {
    userCode: code,
    userId: checked.session.user.id,
    decision,
    ip: clientIp(request),
    mayCreate: checked.form.get('create') === 'yes',
  });
  if (!decided.ok)
    return seeOther(request, `/settings/keys?error=${encodeURIComponent(decided.reason)}`);
  return seeOther(request, `/settings/keys/add?done=${decided.approved ? 'approved' : 'denied'}`);
}
