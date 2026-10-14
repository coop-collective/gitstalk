import { describe, expect, it } from 'vitest';

import { RunId } from '@gitstalk/shared-race/ids';

import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import { registryClient } from '../repositories/registry-client';
import type { ChangeReads, RepoAccess } from './changes-api';
import { answerEvents, answerPushed } from './changes-api';
import { repoAccess } from './repo-access';
import { GREETER_EVENTS, GREETER_PUSHED } from './testing/greeter';

const coop = { id: 'u_coop', handle: 'coop', email: 'coop@example.test' };
const dana = { id: 'u_dana', handle: 'dana', email: 'dana@example.test' };
const ENGINE = RunId.parse('greeter01');

const record = (name: string, visibility: 'public' | 'private') => ({
  id: `repo-${name}`,
  owner: { id: coop.id, handle: coop.handle },
  name,
  description: '',
  visibility,
  origin: { kind: 'empty' },
  artifacts_repo: `art-${name}`,
  engine_id: ENGINE,
  default_branch: 'stalk',
  created_at: '2026-10-07T00:00:00.000Z',
  updated_at: '2026-10-07T00:00:00.000Z',
});

const unused = async () => ({
  ok: false as const,
  error: { code: 'unavailable', status: 503, message: 'not in this fake' },
});

/** The registry's `getRepository` rule: a private repository exists for its owner only. */
function fakeRegistry() {
  const records = [record('greeter', 'private'), record('notes', 'public')];
  return registryClient({
    createRepository: unused,
    listRepositories: unused,
    updateRepository: unused,
    deleteRepository: unused,
    repositoryActivity: unused,
    repositoryFiles: unused,
    async getRepository(handle: string, name: string, viewer: string | null) {
      const found = records.find((r) => r.owner.handle === handle && r.name === name);
      if (found === undefined || (found.visibility === 'private' && viewer !== coop.id))
        return { ok: false, error: { code: 'not_found', status: 404, message: 'not found' } };
      return { ok: true, value: { ...found, viewer_role: viewer === coop.id ? 'owner' : null } };
    },
  });
}

/** Engine reads that count how often they are made. */
function countingReads(events: readonly RaceEvent[] = GREETER_EVENTS) {
  const calls: string[] = [];
  const reads: ChangeReads = {
    engine: ENGINE,
    events: async () => {
      calls.push('events');
      return events;
    },
    pushed: async () => {
      calls.push('pushed');
      return GREETER_PUSHED;
    },
  };
  return { reads, calls };
}

const access = (repo: string, viewer: typeof coop | null, reads: ChangeReads | null) =>
  repoAccess({ owner: 'coop', repo, viewer, registry: fakeRegistry(), readsFor: () => reads });

const get = (query = '') =>
  new Request(`https://gitstalk.test/api/repos/coop/greeter/events${query}`);

describe('the Changes JSON routes', () => {
  it('answer a private repository’s events to its owner, private and revalidated', async () => {
    const { reads } = countingReads();
    const response = await answerEvents(get(), await access('greeter', coop, reads));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('etag')).toBe(`W/"seq-${GREETER_EVENTS.at(-1)?.seq}"`);
    const body: unknown = await response.json();
    expect(body).toEqual({ events: JSON.parse(JSON.stringify(GREETER_EVENTS)) });
  });

  it('give anyone else the same 404 as a missing repository, without reading the engine', async () => {
    const { reads, calls } = countingReads();
    const refused = await Promise.all([
      access('greeter', dana, reads),
      access('greeter', null, reads),
      access('missing', coop, reads),
    ]);
    expect(refused).toEqual(Array.from({ length: 3 }, () => ({ kind: 'not-found' })));
    const responses = await Promise.all(
      refused.flatMap((found) => [answerEvents(get(), found), answerPushed(get(), found)]),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 6 }, () => 404),
    );
    expect(
      responses.every((response) => response.headers.get('cache-control') === 'no-store'),
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  it('serve a public repository to a signed-out reader', async () => {
    const { reads } = countingReads();
    const response = await answerPushed(get(), await access('notes', null, reads));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('etag')).toBeNull();
    const body: unknown = await response.json();
    expect(body).toEqual({ pushed: GREETER_PUSHED });
  });

  it('return only the events after ?after=', async () => {
    const { reads } = countingReads();
    const after = GREETER_EVENTS.at(-3)?.seq ?? 0;
    const response = await answerEvents(
      get(`?after=${after}`),
      await access('greeter', coop, reads),
    );
    const body: unknown = await response.json();
    expect(body).toEqual({ events: JSON.parse(JSON.stringify(GREETER_EVENTS.slice(-2))) });
  });

  it('refuse an ?after= that is not a non-negative integer', async () => {
    const { reads, calls } = countingReads();
    const found = await access('greeter', coop, reads);
    const responses = await Promise.all(
      ['?after=-1', '?after=1.5', '?after=soon'].map((query) => answerEvents(get(query), found)),
    );
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(calls).toEqual([]);
  });

  it('say so when the engine is unusable or the gateway fails', async () => {
    expect((await answerPushed(get(), await access('greeter', coop, null))).status).toBe(503);
    const failing: RepoAccess = {
      kind: 'found',
      reads: {
        engine: ENGINE,
        events: () => Promise.reject(new Error('gateway down')),
        pushed: () => Promise.reject(new Error('gateway down')),
      },
    };
    expect((await answerEvents(get(), failing)).status).toBe(502);
    expect((await answerPushed(get(), failing)).status).toBe(502);
  });
});

describe('revalidating the events', () => {
  const lastSeq = GREETER_EVENTS.at(-1)?.seq ?? 0;
  const revalidating = (etag: string) =>
    new Request('https://gitstalk.test/api/repos/coop/greeter/events', {
      headers: { 'if-none-match': etag },
    });

  it('answer 304 without a body when the viewer holds the newest events', async () => {
    const { reads } = countingReads();
    const response = await answerEvents(
      revalidating(`W/"seq-${lastSeq}"`),
      await access('greeter', coop, reads),
    );
    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(await response.text()).toBe('');
  });

  it('answer the events again once the log has grown past the held ETag', async () => {
    const { reads } = countingReads();
    const response = await answerEvents(
      revalidating(`W/"seq-${lastSeq - 1}"`),
      await access('greeter', coop, reads),
    );
    expect(response.status).toBe(200);
  });

  it('never answer 304 to someone who may not read the repository', async () => {
    const { reads, calls } = countingReads();
    const responses = await Promise.all(
      [dana, null].map(async (viewer) =>
        answerEvents(revalidating(`W/"seq-${lastSeq}"`), await access('greeter', viewer, reads)),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    expect(responses.map((response) => response.headers.get('cache-control'))).toEqual([
      'no-store',
      'no-store',
    ]);
    expect(calls).toEqual([]);
  });
});
