/**
 * What a new repository's first commit holds: a README for an empty start, or a template.
 * The TypeScript starter has no dependencies and real tests (`node --test` runs the `.ts`
 * files directly on Node 23.6+, the runner's Node 25 included), so checks mean something
 * from the first bean.
 */
import { CHECKS_PATH } from '@gitstalk/shared-race/checks-config';
import { CHECKS_SCHEMA_URL } from '@gitstalk/shared-race/checks-yaml';
import type { RepoTemplate } from '@gitstalk/shared-race/repos';

import { assertNever } from '../engine/errors';

import type { SeedFile } from '../git/seed-pack';

export function emptyStart(repoName: string, description: string): readonly SeedFile[] {
  const about = description === '' ? '' : `\n${description}\n`;
  return [{ path: 'README.md', content: `# ${repoName}\n${about}` }];
}

/** A template's files for `repo`; `webUrl` is the deployment's origin, where its docs are. */
export function templateFiles(
  template: RepoTemplate,
  repo: { readonly name: string; readonly description: string },
  webUrl: string,
): readonly SeedFile[] {
  switch (template) {
    case 'typescript-starter':
      return typescriptStarter(repo.name, repo.description, new URL('/docs/checks', webUrl).href);
    default:
      return assertNever(template);
  }
}

function typescriptStarter(
  repoName: string,
  description: string,
  checksDocs: string,
): readonly SeedFile[] {
  const about = description === '' ? 'A small TypeScript project.' : description;
  return [
    { path: 'README.md', content: starterReadme(repoName, about) },
    { path: '.gitignore', content: 'node_modules/\n' },
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: npmName(repoName),
          private: true,
          type: 'module',
          engines: { node: '>=23.6' },
          scripts: { test: 'node --test "test/**/*.test.ts"' },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'es2023',
            module: 'nodenext',
            strict: true,
            noEmit: true,
            erasableSyntaxOnly: true,
            allowImportingTsExtensions: true,
            verbatimModuleSyntax: true,
          },
          include: ['src', 'test'],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: CHECKS_PATH,
      content: [
        `# yaml-language-server: $schema=${CHECKS_SCHEMA_URL}`,
        '# What a bean must pass before it lands, run on the exact tree it would land on.',
        `# Format: ${checksDocs}`,
        '# Only the owner or a maintainer, pushing with a personal token or an SSH key, may change',
        '# this file (always protected).',
        'image: node',
        'timeout-minutes: 2',
        'run: [node, --test]',
        'protected-paths: []',
        '',
      ].join('\n'),
    },
    { path: 'src/text.ts', content: STARTER_SOURCE },
    { path: 'test/text.test.ts', content: STARTER_TEST },
  ];
}

function starterReadme(repoName: string, about: string): string {
  return `# ${repoName}

${about}

## Run the tests

\`\`\`sh
npm test
\`\`\`

No install step: Node 23.6 or newer runs the TypeScript files directly.

## How changes land

Every change is a bean: a branch named \`bean/<name>\`. Push one and Gitstalk checks it on
the exact tree it would land on (\`.gitstalk/checks.yml\`), puts it on the sprout, and moves
it to the stalk once it stays green.
`;
}

const STARTER_SOURCE = `/** Lower-case words joined by hyphens: "Hello, World!" becomes "hello-world". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Each word with a capital first letter: "the stalk grows" becomes "The Stalk Grows". */
export function titleCase(text: string): string {
  return text.replace(/\\p{L}[\\p{L}']*/gu, (word) => word[0]?.toUpperCase() + word.slice(1));
}
`;

const STARTER_TEST = `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { slugify, titleCase } from '../src/text.ts';

describe('slugify', () => {
  it('joins lower-case words with hyphens', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
  });

  it('drops accents', () => {
    assert.equal(slugify('Crème brûlée'), 'creme-brulee');
  });
});

describe('titleCase', () => {
  it('capitalises every word', () => {
    assert.equal(titleCase('the stalk grows'), 'The Stalk Grows');
  });
});
`;

/** An npm package name from a repository name: lower case, no leading dot or underscore. */
function npmName(repoName: string): string {
  const name = repoName.toLowerCase().replace(/^[._]+/, '');
  return name === '' ? 'starter' : name;
}
