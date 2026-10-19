import { mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshot } from './snapshot';

describe('skipper snapshots', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), 'beanstalk-skipper-'));
    roots.push(directory);
    writeFileSync(
      join(directory, 'unit.test.ts'),
      "import { test } from 'node:test'; test('works', () => {});",
    );
    return directory;
  }

  it('binds evidence to content, file modes, test inventory and runtime', () => {
    const directory = root();
    const before = snapshot(directory);
    expect(before.reason).toBeNull();
    expect(before.tests).toEqual({ 'unit.test.ts': ['unit.test.ts'] });
    expect(before.environment).toContain(process.version);
    chmodSync(join(directory, 'unit.test.ts'), 0o755);
    expect(snapshot(directory).files['unit.test.ts']).not.toEqual(before.files['unit.test.ts']);
    writeFileSync(join(directory, 'config.json'), '{"enabled":true}');
    expect(snapshot(directory).files).toHaveProperty('config.json');
    writeFileSync(join(directory, '__proto__'), 'input');
    expect(Object.hasOwn(snapshot(directory).files, '__proto__')).toBe(true);
  });

  it('rejects symlinks and invalid UTF-8 sources instead of trusting partial inputs', () => {
    const directory = root();
    symlinkSync('/etc/passwd', join(directory, 'outside'));
    expect(snapshot(directory).reason).toBe('unsupported-tree');
    rmSync(join(directory, 'outside'));
    writeFileSync(join(directory, 'bad.ts'), Buffer.from([0xff]));
    expect(snapshot(directory).reason).toBe('unsupported-tree');
  });
});
