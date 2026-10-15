import { describe, expect, it } from 'vitest';

import {
  IMMUTABLE,
  NO_STORE,
  REVALIDATE,
  cacheControl,
  isNotModified,
  jsonAnswer,
  byVisibility,
  eventsEtag,
  pairEtag,
  problem,
  serverTiming,
} from './http-cache';
import { publicOutcome } from './object-cache';
import { privateOutcome } from './private-object-cache';

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

describe('rules by visibility', () => {
  it('keep a public repository’s rule and never keep anyone else’s', () => {
    const rules = { public: IMMUTABLE, restricted: NO_STORE };
    expect(byVisibility('public', rules)).toBe(IMMUTABLE);
    expect(byVisibility('private', rules)).toBe(NO_STORE);
    expect(byVisibility('internal', rules)).toBe(NO_STORE);
  });
});

describe('ETags', () => {
  const last = { seq: 42, ts: '2026-10-14T12:00:00.000Z' };
  const tag = eventsEtag('engine01', 0, last);

  it('name a diff by its version and commit pair, and events by engine and last event', () => {
    expect(pairEtag('a1', 'b2')).toBe('"v1.a1..b2"');
    expect(tag).toBe('W/"v1.engine01.42.2026-10-14T12:00:00.000Z"');
    expect(eventsEtag('engine01', 7, undefined)).toBe('W/"v1.engine01.7.none"');
  });

  it('differ by engine, and by the last event’s time at the same seq (a reset log)', () => {
    expect(eventsEtag('engine02', 0, last)).not.toBe(tag);
    expect(eventsEtag('engine01', 0, { ...last, ts: '2026-10-15T00:00:00.000Z' })).not.toBe(tag);
  });

  it('match If-None-Match weakly, in a list, or as *', () => {
    const strong = tag.slice(2);
    expect(isNotModified(get(tag), tag)).toBe(true);
    expect(isNotModified(get(strong), tag)).toBe(true);
    expect(isNotModified(get(`"x", ${tag}`), tag)).toBe(true);
    expect(isNotModified(get('*'), tag)).toBe(true);
    expect(isNotModified(get(eventsEtag('engine01', 0, { ...last, seq: 41 })), tag)).toBe(false);
    expect(isNotModified(get(), tag)).toBe(false);
  });
});

describe('JSON answers', () => {
  it('carry the rule, the ETag and the timing', async () => {
    const response = jsonAnswer(
      get(),
      { ok: true },
      { rule: IMMUTABLE, etag: '"a..b"', timing: { outcome: 'colo-hit', ms: 1.84 } },
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
  it('names what the read came to, public and private KV counted apart', () => {
    expect(serverTiming(publicOutcome('isolate'), 0.04)).toBe('edge;desc="isolate-hit";dur=0.0');
    expect(serverTiming(publicOutcome('kv'), 12)).toBe('edge;desc="kv-hit";dur=12.0');
    expect(serverTiming(publicOutcome('gateway'), 80.26)).toBe('edge;desc="kv-miss";dur=80.3');
    expect(serverTiming(privateOutcome('kv'), 3)).toBe('edge;desc="kv-hit-private";dur=3.0');
    expect(serverTiming(privateOutcome('gateway'), 3)).toBe('edge;desc="kv-miss-private";dur=3.0');
  });
});
