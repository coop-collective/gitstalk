import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { describe, expect, it } from 'vitest';

import type { PersistStorage } from './persistence';
import {
  PERSIST_STORAGE_KEY,
  forgetPersistedCache,
  gateByBuster,
  guardedStorage,
  persistBuster,
  shouldPersistQuery,
} from './persistence';

type QueryLike = Parameters<typeof shouldPersistQuery>[0];

function query(meta: QueryLike['meta'], status: QueryLike['state']['status']): QueryLike {
  return {
    meta,
    state: {
      status,
      data: undefined,
      dataUpdateCount: 0,
      dataUpdatedAt: 0,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      fetchStatus: 'idle',
    },
  };
}

describe('the persister filter', () => {
  it('keeps a successful query that opted in', () => {
    expect(shouldPersistQuery(query({ persist: true }, 'success'))).toBe(true);
  });

  it.each([
    ['no meta', undefined, 'success'],
    ['persist false', { persist: false }, 'success'],
    ['other meta only', { label: 'x' }, 'success'],
    ['pending data', { persist: true }, 'pending'],
    ['an error', { persist: true }, 'error'],
  ] as const)('skips a query with %s', (_name, meta, status) => {
    expect(shouldPersistQuery(query(meta, status))).toBe(false);
  });
});

describe('the buster', () => {
  it('ties the stored cache to the build and the viewer', () => {
    expect(persistBuster('b1', 'u1')).toBe('b1:u1');
    expect(persistBuster('b1', 'u1')).not.toBe(persistBuster('b1', 'anon'));
    expect(persistBuster('b1', 'u1')).not.toBe(persistBuster('b2', 'u1'));
  });
});

describe('gateByBuster', () => {
  function recording() {
    const written: PersistedClient[] = [];
    const persister: Persister = {
      persistClient: (client) => {
        written.push(client);
      },
      restoreClient: () => undefined,
      removeClient: () => undefined,
    };
    return { written, persister };
  }
  const client = (buster: string): PersistedClient => ({
    buster,
    timestamp: 0,
    clientState: { queries: [], mutations: [] },
  });

  it('writes a cache carrying the current buster', async () => {
    const { written, persister } = recording();
    await gateByBuster(persister, () => 'b:u1').persistClient(client('b:u1'));
    expect(written).toHaveLength(1);
  });

  it('drops a cache carrying a previous viewer’s buster', async () => {
    const { written, persister } = recording();
    await gateByBuster(persister, () => 'b:u2').persistClient(client('b:u1'));
    expect(written).toHaveLength(0);
  });
});

describe('guarded storage', () => {
  const throwing: PersistStorage = {
    getItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError');
    },
    removeItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
  };

  it('reads as empty and drops writes when storage throws', () => {
    const storage = guardedStorage(throwing);
    expect(storage.getItem(PERSIST_STORAGE_KEY)).toBeNull();
    expect(() => storage.setItem(PERSIST_STORAGE_KEY, '{}')).not.toThrow();
    expect(() => storage.removeItem(PERSIST_STORAGE_KEY)).not.toThrow();
  });

  it('forgets the stored cache, and survives blocked or missing storage', () => {
    const values = new Map([[PERSIST_STORAGE_KEY, '{}']]);
    forgetPersistedCache({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    });
    expect(values.has(PERSIST_STORAGE_KEY)).toBe(false);
    expect(() => forgetPersistedCache(throwing)).not.toThrow();
    expect(() => forgetPersistedCache(undefined)).not.toThrow();
  });
});
