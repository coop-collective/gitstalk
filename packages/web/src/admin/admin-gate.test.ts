import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The admin gate is a call each page makes (the pages need the request's session), so these
 * tests read the router's files: every admin page, every run API and every old race URL must
 * go through it, and nothing a normal user sees may link to the races.
 */
const WEB = fileURLToPath(new URL('../..', import.meta.url));

function filesUnder(dir: string, name: RegExp): readonly string[] {
  return readdirSync(path.join(WEB, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => name.test(path.basename(file)))
    .map((file) => path.join(dir, file));
}

function source(file: string): string {
  return readFileSync(path.join(WEB, file), 'utf8');
}

describe('the admin gate', () => {
  const adminPages = filesUnder('app/admin', /^(page|layout)\.tsx$/);

  it('finds the admin area: overview, runs, the race, run pages, the demo gate', () => {
    expect(adminPages.map((file) => file.replaceAll(path.sep, '/')).toSorted()).toEqual([
      'app/admin/demo-gate/page.tsx',
      'app/admin/layout.tsx',
      'app/admin/page.tsx',
      'app/admin/race/page.tsx',
      'app/admin/runs/[run]/files/page.tsx',
      'app/admin/runs/[run]/page.tsx',
      'app/admin/runs/[run]/race/page.tsx',
      'app/admin/runs/page.tsx',
    ]);
  });

  it.each(adminPages)('%s answers anyone but a platform admin with the 404', (file) => {
    expect(source(file)).toMatch(/await requirePlatformAdmin\(\)/);
  });

  it.each(filesUnder('app/api/runs', /^route\.ts$/))(
    '%s streams a race to platform admins only, a repository to its readers',
    (file) => {
      // `runAccess` is the same gate, also naming the repository's visibility (the diff
      // route edge-caches a public repository's diff by its commit pair).
      expect(source(file)).toMatch(/await (mayStreamRun|runAccess)\(request, run\.data\)/);
    },
  );

  it.each(['app/race/page.tsx', 'app/races/page.tsx', 'app/runs/[...path]/page.tsx'])(
    'the old URL %s sends admins on and 404s for everyone else',
    (file) => {
      expect(source(file)).toMatch(/redirectToAdmin\(/);
    },
  );

  it('leaves the repository live feed to repository readers', () => {
    expect(source('app/api/repos/[owner]/[repo]/live/route.ts')).not.toMatch(/platformAdmin/);
  });
});

describe('what a normal user sees', () => {
  /** Pages and components outside the admin area and the race views it alone renders. */
  const RACE_ONLY =
    /^(app\/admin|app\/race|app\/races|app\/runs|components\/(canvas|race|runs|admin))\//;
  const visible = [
    ...filesUnder('app', /\.tsx$/),
    ...filesUnder('components', /\.tsx?$/),
    'src/shell/header-entries.ts',
  ]
    .map((file) => file.replaceAll(path.sep, '/'))
    .filter((file) => !RACE_ONLY.test(file));

  it.each(visible)('%s links to no race, benchmark or demo gate', (file) => {
    const text = source(file);
    expect(text).not.toMatch(/href=["'{`]+\/(races?|runs)\b/);
    expect(text).not.toMatch(/['`]\/(races?|runs)\/?['`$]/);
    expect(text).not.toMatch(/Benchmark runs|Watch the race|demo gate|Demo password/i);
  });
});
