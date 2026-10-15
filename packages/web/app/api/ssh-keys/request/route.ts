import { env } from 'cloudflare:workers';

import { isWithinLimits } from '@gitstalk/shared-identity/rate-limit';
import { clientIp } from '@gitstalk/shared-identity/request-context';
import { startKeyRequest } from '@gitstalk/shared-identity/ssh-key-requests';

import { problem } from '../../../../src/auth/http';
import { log } from '../../../../src/log';
import { KeyRequestBody, keyRequestAnswer, wantsCreate } from '../../../../src/setup/setup-api';

/**
 * Starts "add this SSH key" from a terminal: no session (the person approves in the browser),
 * only a public key and the machine's name. Rate limited per IP like sign-in.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(request.headers.get('content-type') ?? '').includes('application/json'))
    return problem(415, 'unsupported_media_type', 'send JSON');
  const ip = clientIp(request) ?? 'unknown';
  if (!(await isWithinLimits(env.SIGNIN_RATE_LIMIT, [`ssh-key:${ip}`])))
    return problem(429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
  const body = KeyRequestBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return problem(400, 'invalid_request', 'send public_key and machine');
  const started = await startKeyRequest(env, {
    publicKey: body.data.public_key,
    machine: body.data.machine,
    httpsToken: body.data.https_token,
    create: wantsCreate(body.data),
  });
  if (!started.ok) return problem(400, 'invalid_key', started.reason);
  log.info('ssh key request started', { fingerprint: started.fingerprint });
  return Response.json(keyRequestAnswer(started, new URL(request.url).origin), {
    headers: { 'cache-control': 'no-store' },
  });
}
