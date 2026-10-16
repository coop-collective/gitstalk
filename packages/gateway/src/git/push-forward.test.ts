import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../log';
import type { GitPath } from './git-path';
import { FLUSH_PKT, concatBytes, pktLine } from './pkt-line';
import { forwardPush } from './push-forward';
import { bytesStream } from './replayable-body';

const path: GitPath = {
  namespace: 'acme',
  repo: 'shop',
  rest: 'git-receive-pack',
  service: 'git-receive-pack',
};
const REF = 'refs/heads/bean/one';
const mode = { sideband: false, reportStatus: true };

function report(line: string): Response {
  return new Response(concatBytes([pktLine('unpack ok\n'), pktLine(`${line}\n`), FLUSH_PKT]));
}

/** Forwards a small push to a remote answering `answers` in turn; how many sends it took. */
async function forwardTo(answers: readonly (() => Response)[]) {
  let sends = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const answer = answers[Math.min(sends, answers.length - 1)];
    sends += 1;
    if (answer === undefined) throw new Error('no answer scripted');
    return answer();
  });
  const forwarded = await forwardPush(new Request('https://gateway.test/', { method: 'POST' }), {
    upstream: 'https://artifacts.test/repo.git',
    path,
    token: 'secret',
    body: bytesStream(new TextEncoder().encode('0000PACK')),
    ref: REF,
    mode,
    log: createLogger('error'),
    retry: { wait: async () => undefined },
  });
  return { forwarded, sends };
}

const busy = (): Response => new Response('artifacts_git_receive_pack_busy', { status: 409 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('forwardPush', () => {
  it('sends a busy push again until it is answered', async () => {
    const { forwarded, sends } = await forwardTo([busy, busy, () => report(`ok ${REF}`)]);

    expect(forwarded.kind).toBe('answered');
    expect(sends).toBe(3);
  });

  it('never sends again once the answer shows the ref moved, whatever else it says', async () => {
    const { forwarded, sends } = await forwardTo([
      () => report(`ok ${REF}`),
      () => new Response('REPO_BUSY'),
    ]);

    expect(forwarded.kind).toBe('answered');
    expect(sends).toBe(1);
  });

  it('never retries another failure', async () => {
    const { forwarded, sends } = await forwardTo([
      () => report(`ng ${REF} fetch first`),
      () => report(`ok ${REF}`),
    ]);

    expect(forwarded).toMatchObject({ kind: 'answered', answer: { status: 200 } });
    expect(sends).toBe(1);
  });

  it('gives up busy when every attempt is busy', async () => {
    const { forwarded, sends } = await forwardTo([() => new Response('busy', { status: 503 })]);

    expect(forwarded.kind).toBe('busy');
    expect(sends).toBe(5);
  });
});
