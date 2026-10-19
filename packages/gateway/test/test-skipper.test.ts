import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { loadRun } from '../src/run/run-store';
import { createRun } from './helpers';

describe('persisted test skipper setting', () => {
  it('persists an explicit opt-in and loads older runs with the skipper off', async () => {
    const run = await createRun({ policy: 'beanstalk-v2', test_skipper: true });
    const stub = env.RUNS.getByName(run.run);
    const enabled = await runInDurableObject(
      stub,
      (_, state) => loadRun(state.storage)?.config.test_skipper,
    );
    expect(enabled).toBe(true);
    const legacy = await runInDurableObject(stub, (_, state) => {
      const config = state.storage.kv.get<Record<string, unknown>>('config');
      if (config === undefined) throw new Error('missing run config');
      delete config['test_skipper'];
      state.storage.kv.put('config', config);
      return loadRun(state.storage)?.config.test_skipper;
    });
    expect(legacy).toBe(false);
  });
});
