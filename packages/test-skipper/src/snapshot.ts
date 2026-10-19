import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { version } from 'acorn';
import { closure, dependencyGraph, isSource } from './graph.ts';

const MAX_FILES = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;

export type Snapshot = {
  readonly files: Readonly<Record<string, string>>;
  readonly tests: Readonly<Record<string, readonly string[]>>;
  readonly environment: string;
  readonly reason: string | null;
};

/** Fingerprints include non-code inputs. Symlinks, large trees and unsupported sources fail closed. */
export function snapshot(root: string): Snapshot {
  const environment = `node-module-v1:${process.version}:${version}`;
  try {
    const { files, fingerprints } = readTree(root);
    const graph = dependencyGraph(files);
    const tests = Object.keys(files).filter((path) => /\.test\.(js|mjs|ts|mts)$/.test(path));
    return {
      files: fingerprints,
      tests: Object.fromEntries(tests.toSorted().map((path) => [path, closure(path, graph)])),
      environment,
      reason: graph.reason ?? (tests.length === 0 ? 'no-test-inventory' : null),
    };
  } catch {
    return { files: {}, tests: {}, environment, reason: 'unsupported-tree' };
  }
}

function readTree(root: string): {
  files: Record<string, string>;
  fingerprints: Record<string, string>;
} {
  const files = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  const directories = [''];
  let bytes = 0;
  for (const directory of directories) {
    for (const name of readdirSync(join(root, directory)).toSorted()) {
      const path = directory ? `${directory}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) {
        if (directories.length >= MAX_FILES) throw new Error('Too many directories');
        directories.push(path);
        continue;
      }
      if (!stat.isFile() || bytes + stat.size > MAX_BYTES || files.size >= MAX_FILES)
        throw new Error('Unsupported tree');
      bytes += stat.size;
      const data = readFileSync(join(root, path));
      fingerprints.set(path, hash(`${stat.mode}:${data.toString('base64')}`));
      // Non-code is fingerprinted without decoding, including binary resources and file modes.
      files.set(
        path,
        isSource(path)
          ? new TextDecoder('utf-8', { fatal: true }).decode(data)
          : `${stat.mode}:${data.toString('base64')}`,
      );
    }
  }
  return { files: Object.fromEntries(files), fingerprints: Object.fromEntries(fingerprints) };
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
