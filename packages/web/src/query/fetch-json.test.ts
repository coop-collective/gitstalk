import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchJson } from './fetch-json';

const isAnything = (value: unknown): value is unknown => value !== undefined;

/** Stands in for the browser's fetch, recording the cache mode each request asked for. */
function recordingFetch() {
  const modes: (RequestCache | undefined)[] = [];
  vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
    modes.push(init.cache);
    return Promise.resolve(Response.json({ ok: true }));
  });
  return modes;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the browser HTTP cache mode', () => {
  it('bypasses the HTTP cache by default', async () => {
    const modes = recordingFetch();
    await fetchJson('/api/x', isAnything);
    expect(modes).toEqual(['no-store']);
  });

  it('revalidates with the stored ETag when asked to', async () => {
    const modes = recordingFetch();
    await fetchJson('/api/repos/a/b/events', isAnything, { httpCache: 'revalidate' });
    expect(modes).toEqual(['no-cache']);
  });
});
