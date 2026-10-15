/**
 * Browser storage for the file tree's conveniences (its width, its open folders). Storage can
 * be missing or throw (a private window, blocked site data, a full quota); then reads are empty
 * and writes are dropped, and the tree works from its defaults.
 */

export type StorageKind = 'local' | 'session';

export function readStored(kind: StorageKind, key: string): string | null {
  try {
    return storageOf(kind)?.getItem(key) ?? null;
  } catch {
    // Unreadable storage remembers nothing: the defaults stand.
    return null;
  }
}

export function writeStored(kind: StorageKind, key: string, value: string): void {
  try {
    storageOf(kind)?.setItem(key, value);
  } catch {
    // Refused (quota, blocked): the tree forgets this, which is all that is lost.
  }
}

function storageOf(kind: StorageKind): Storage | null {
  if (typeof window === 'undefined') return null;
  return kind === 'local' ? window.localStorage : window.sessionStorage;
}
