import { describe, expect, it } from 'vitest';

import { TaskId } from '@gitstalk/shared-race/ids';

import { classifierFrom } from '@gitstalk/shared-ask/ask/classifier-from-env';
import { gatewaySource } from '@gitstalk/shared-ask/forge/gateway-source';
import { pickerFrom } from '@gitstalk/shared-ask/pick/picker-from-env';

import { changeStatus } from '../src/tools/change-status';
import { toolContext } from '../src/tools/tool-context';
import { workOverlaps } from '../src/tools/work-overlaps';
import { fakeGateway, RUN } from './fake-gateway';

const PATH = 'src/streamed/only-here.ts';

/** t005 of the recorded run, as if its agent were writing a file it never committed. */
const STREAM = {
  type: 'bean.streaming',
  task: 't005',
  inv: 'inv0099-rework',
  agent: 'a3',
  seq: 4,
  t: 120.5,
  files: [{ path: PATH, status: 'added', additions: 12, deletions: 0 }],
  additions: 12,
  deletions: 0,
  truncated: false,
  redacted: 0,
};

function context(streams: unknown[]) {
  const gateway = fakeGateway({ beanStreams: () => Promise.resolve({ ok: true, value: streams }) });
  return toolContext({
    run: RUN,
    gateway,
    source: gatewaySource(gateway),
    classifier: classifierFrom({ name: 'keywords', model: '', ai: undefined }),
    picker: pickerFrom({ name: 'rules', ai: undefined, gateway: '' }),
    webUrl: 'https://web.test',
  });
}

describe('the observed footprint (stream_diffs)', () => {
  it('work_overlaps names a bean whose agent is editing the path before any commit', async () => {
    const answer = await workOverlaps(context([STREAM]), [PATH]);

    expect(answer.beans).toMatchObject([{ bean: 't005', overlap: [PATH], editing_now: [PATH] }]);
  });

  it('bean_status says what the agent is editing right now', async () => {
    const answer = await changeStatus(context([STREAM]), TaskId.parse('t005'));

    expect(answer?.editing_now).toEqual({
      files: [{ path: PATH, additions: 12, deletions: 0 }],
      snapshot: 4,
      at_s: 121,
    });
  });

  it('answers from the event log alone when nothing streams', async () => {
    const answer = await workOverlaps(context([]), [PATH]);

    expect(answer.beans).toEqual([]);
  });
});
