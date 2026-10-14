import { describe, expect, it } from 'vitest';

import { ownersOf } from './blame-spans';
import type { ChangedPath, Changeset, ParentState } from './deriver';
import type { BlameRow } from './derivers';
import { beanBlame, spansFor } from './derivers';

/** Rows by path and position, as the store keeps them. */
class MemoryRows implements ParentState<BlameRow> {
  readonly #rows = new Map<string, Map<number, BlameRow>>();

  at(path: string, seq: number): BlameRow | null {
    const rows = this.#rows.get(path);
    if (rows === undefined) return null;
    const best = [...rows.keys()].filter((key) => key <= seq).toSorted((a, b) => b - a)[0];
    return best === undefined ? null : (rows.get(best) ?? null);
  }

  apply(changeset: Changeset): void {
    for (const { path, row } of beanBlame.compute(changeset, this)) {
      const rows = this.#rows.get(path) ?? new Map<number, BlameRow>();
      rows.set(changeset.seq, row);
      this.#rows.set(path, rows);
    }
  }

  owners(path: string, seq: number, content: string): number[] {
    return ownersOf(spansFor(this.at(path, seq), content));
  }
}

function text(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

function modified(path: string, before: string, after: string, restored?: string): ChangedPath {
  return {
    path,
    change: 'modified',
    text: { before, after },
    ...(restored === undefined ? {} : { restored }),
  };
}

function landing(seq: number, paths: readonly ChangedPath[]): Changeset {
  return {
    sha: String(seq).repeat(40),
    seq,
    kind: 'landing',
    bean: `b${seq}`,
    restores: null,
    paths,
  };
}

describe('bean_blame', () => {
  const base = [
    'import { rate } from "./rate";',
    'const TAX = 0.2;',
    'export function tax(x) {',
    '  return x * TAX;',
    '}',
  ];

  it('gives each changed line to the landing that changed it and keeps the rest', () => {
    const rows = new MemoryRows();
    const one = ['import { rate } from "./rate";', 'const TAX = 0.25;', ...base.slice(2)];
    rows.apply(landing(1, [modified('tax.ts', text(base), text(one))]));
    expect(rows.owners('tax.ts', 1, text(one))).toEqual([0, 1, 0, 0, 0]);
    const two = [...one, 'export const zero = 0;'];
    rows.apply(landing(2, [modified('tax.ts', text(one), text(two))]));
    expect(rows.owners('tax.ts', 2, text(two))).toEqual([0, 1, 0, 0, 0, 2]);
    // The state at an older position is still there.
    expect(rows.owners('tax.ts', 1, text(one))).toEqual([0, 1, 0, 0, 0]);
  });

  it('a revert gives the reverted lines back to their previous owners and keeps later beans', () => {
    const rows = new MemoryRows();
    const one = [base[0] ?? '', 'const TAX = 0.25;', ...base.slice(2)];
    rows.apply(landing(1, [modified('tax.ts', text(base), text(one))]));
    const two = [...one, 'export const zero = 0;'];
    rows.apply(landing(2, [modified('tax.ts', text(one), text(two))]));
    // Revert landing 1 (it restores position 0): its line goes back, landing 2's stays.
    const three = [...base, 'export const zero = 0;'];
    rows.apply({
      sha: '3'.repeat(40),
      seq: 3,
      kind: 'revert',
      bean: 'b1',
      restores: 0,
      paths: [modified('tax.ts', text(two), text(three), text(base))],
    });
    expect(rows.owners('tax.ts', 3, text(three))).toEqual([0, 0, 0, 0, 0, 2]);
  });

  it('restores randomly placed replacements while keeping a later append', () => {
    for (let at = 0; at < base.length; at += 1) {
      const rows = new MemoryRows();
      const one = base.map((line, index) => (index === at ? `${line} // changed` : line));
      rows.apply(landing(1, [modified('f', text(base), text(one))]));
      const two = ['// header', ...one];
      rows.apply(landing(2, [modified('f', text(one), text(two))]));
      const three = ['// header', ...base];
      rows.apply({
        sha: '3'.repeat(40),
        seq: 3,
        kind: 'revert',
        bean: 'b1',
        restores: 0,
        paths: [modified('f', text(two), text(three), text(base))],
      });
      expect(rows.owners('f', 3, text(three))).toEqual([2, 0, 0, 0, 0, 0]);
    }
  });

  it('records deletions and files it cannot read as text', () => {
    const rows = new MemoryRows();
    rows.apply(
      landing(1, [
        { path: 'gone.ts', change: 'deleted', text: { before: 'x\n', after: null } },
        { path: 'logo.png', change: 'added', text: null },
      ]),
    );
    expect(rows.at('gone.ts', 1)).toEqual({ kind: 'deleted' });
    expect(rows.at('logo.png', 1)).toEqual({ kind: 'opaque', owner: 1 });
  });
});
