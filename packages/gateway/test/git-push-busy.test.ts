import { afterEach, describe, expect, it, vi } from 'vitest';

import { advertisedRefs, gitResponse, openRepo, push, pushBody, until } from './git-push-helpers';
import { sha } from './helpers';

/**
 * Artifacts answers a receive-pack that arrives while another push to the same repository is
 * being applied with `artifacts_git_receive_pack_busy`. The gateway sends the push again after
 * a short backoff (here the backoff resolves at once), and only says so to git when the
 * repository stays busy.
 */

const realFetch = globalThis.fetch;

/** Answers busy to the first `times` receive-packs of the bean, then lets them reach the fake remote. */
function busyRemote(bean: string, times: number): { readonly sent: () => number } {
  let sent = 0;
  vi.spyOn(scheduler, 'wait').mockResolvedValue(undefined);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/git-receive-pack') || !(init?.body instanceof ReadableStream))
      return realFetch(input, init);
    const body = new Uint8Array(await new Response(init.body).arrayBuffer());
    if (!new TextDecoder().decode(body).includes(`refs/heads/bean/${bean}`))
      return realFetch(input, { ...init, body });
    sent += 1;
    if (sent > times) return realFetch(input, { ...init, body });
    return new Response('artifacts_git_receive_pack_busy\n', {
      status: 409,
      headers: { 'content-type': 'text/plain' },
    });
  });
  return { sent: () => sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a push while the repository is busy with another', () => {
  it('is sent again and lands when the repository frees up', async () => {
    const { opened, token } = await openRepo('busy-once');
    const remote = busyRemote('busy-once', 1);

    const response = await push(
      opened.git_path,
      token,
      pushBody({ ref: 'refs/heads/bean/busy-once', newSha: await sha('busy-once-1') }),
    );

    expect(response.status).toBe(200);
    const output = await gitResponse(response);
    expect(output.report).toContain('ok refs/heads/bean/busy-once');
    expect(output.remote).toContain('new bean busy-once received');
    expect(remote.sent()).toBe(2);
    vi.restoreAllMocks();
    expect(await advertisedRefs(opened.git_path, token)).toContain('refs/heads/bean/busy-once');
    await until(opened.engineId, 'busy-once', ['landed', 'green']);
  });

  it('tells git the repository is busy when it stays busy, instead of hanging up', async () => {
    const { opened, token } = await openRepo('busy-always');
    const remote = busyRemote('busy-always', Number.POSITIVE_INFINITY);

    const response = await push(
      opened.git_path,
      token,
      pushBody({ ref: 'refs/heads/bean/busy-always', newSha: await sha('busy-always-1') }),
    );

    expect(response.status).toBe(200);
    const output = await gitResponse(response);
    expect(output.report).toContain('ng refs/heads/bean/busy-always');
    expect(output.remote).toContain(
      'gitstalk: push refused: the repository is busy with other pushes; push again in a few seconds',
    );
    expect(remote.sent()).toBe(5);
    vi.restoreAllMocks();
    expect(await advertisedRefs(opened.git_path, token)).not.toContain('bean/busy-always');
  });
});
