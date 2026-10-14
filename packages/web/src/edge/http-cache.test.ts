import { describe, expect, it } from 'vitest';

import {
  IMMUTABLE,
  NO_STORE,
  REVALIDATE,
  cacheControl,
  isNotModified,
  jsonAnswer,
  pairEtag,
  problem,
  seqEtag,
  serverTiming,
} from './http-cache';

const get = (ifNoneMatch?: string) =>
  new Request('https://gitstalk.test/api/x', {
    headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch },
  });

describe('Cache-Control', () => {
  it('says private for every kept answer and never names a shared cache', () => {
    const values = [
      cacheControl(REVALIDATE),
      cacheControl({ kind: 'fresh-for', seconds: 30 }),
      cacheControl(IMMUTABLE),
    ];
    expect(values).toEqual([
      'private, no-cache',
      'private, max-age=30',
      'private, max-age=31536000, immutable',
    ]);
    for (const value of [...values, cacheControl(NO_STORE)]) {
      expect(value).not.toContain('s-maxage');
      expect(value).not.toContain('public');
    }
  });
});

describe('ETags', () => {
  it('name a diff by its commit pair, and an event list by its last seq', () => {
    expect(pairEtag('a1', 'b2')).toBe('"a1..b2"');
    expect(seqEtag(42)).toBe('W/"seq-42"');
  });

  it('match If-None-Match weakly, in a list, or as *', () => {
    expect(isNotModified(get('W/"seq-42"'), seqEtag(42))).toBe(true);
    expect(isNotModified(get('"seq-42"'), seqEtag(42))).toBe(true);
    expect(isNotModified(get('"x", W/"seq-42"'), seqEtag(42))).toBe(true);
    expect(isNotModified(get('*'), seqEtag(42))).toBe(true);
    expect(isNotModified(get('W/"seq-41"'), seqEtag(42))).toBe(false);
    expect(isNotModified(get(), seqEtag(42))).toBe(false);
  });
});

describe('JSON answers', () => {
  it('carry the rule, the ETag and the timing', async () => {
    const response = jsonAnswer(
      get(),
      { ok: true },
      { rule: IMMUTABLE, etag: '"a..b"', timing: { layer: 'colo', ms: 1.84 } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('etag')).toBe('"a..b"');
    expect(response.headers.get('server-timing')).toBe('edge;desc="colo-hit";dur=1.8');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answer 304 with no body when the browser holds the same ETag', async () => {
    const response = jsonAnswer(get('"a..b"'), { ok: true }, { rule: REVALIDATE, etag: '"a..b"' });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('"a..b"');
    expect(await response.text()).toBe('');
  });

  it('never answer 304 without an ETag', () => {
    expect(jsonAnswer(get('*'), {}, { rule: REVALIDATE }).status).toBe(200);
  });

  it('keep errors out of every cache, with no ETag or timing', () => {
    const response = problem(404, 'no such repository');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('server-timing')).toBeNull();
  });
});

describe('Server-Timing', () => {
  it('names the layer that served the object', () => {
    expect(serverTiming('isolate', 0.04)).toBe('edge;desc="isolate-hit";dur=0.0');
    expect(serverTiming('kv', 12)).toBe('edge;desc="kv-hit";dur=12.0');
    expect(serverTiming('gateway', 80.26)).toBe('edge;desc="gateway-read";dur=80.3');
  });
});
