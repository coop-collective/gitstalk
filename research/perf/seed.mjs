// Gives the perf repo history: clones it (token from <dir>/token.txt), pushes beans with
// `git push -o wait`, one of them adding a workflow so an Actions run exists.
// Usage: node research/perf/seed.mjs --base https://gitstalk.dev --dir <secrets dir> [--beans 2]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { arg } from './lib.mjs';

const base = arg('base', 'https://gitstalk.dev');
const dir = arg('dir');
if (!dir) throw new Error('--dir <secrets dir> is required');
const handle = readFileSync(`${dir}/handle.txt`, 'utf8').trim();
const token = readFileSync(`${dir}/token.txt`, 'utf8').trim();
const repo = arg('repo', 'perf-repo');
const work = `${dir}/clone`;
const run = (args, cwd = work) => {
  try {
    return execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (e) {
    throw new Error(String(e.stderr || e.message).replaceAll(token, '<token>'));
  }
};

rmSync(work, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
run(['clone', '-q', `https://${handle}:${token}@${new URL(base).host}/${handle}/${repo}.git`, work], dir);
run(['config', 'user.email', 'perf@example.invalid']);
run(['config', 'user.name', 'perf']);

const beans = [
  {
    name: 'add-truncate',
    edit() {
      appendFileSync(`${work}/src/text.ts`, '\n/** Truncate to n characters with an ellipsis. */\nexport function truncate(text: string, n: number): string {\n  return text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1))}…`;\n}\n');
      mkdirSync(`${work}/.github/workflows`, { recursive: true });
      writeFileSync(`${work}/.github/workflows/ci.yml`, 'name: ci\non:\n  push:\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: node --version\n      - run: node --test\n');
    },
  },
  {
    name: 'add-count-words',
    edit() {
      appendFileSync(`${work}/src/text.ts`, '\n/** Number of words in the text. */\nexport function countWords(text: string): number {\n  return text.split(/\\s+/).filter(Boolean).length;\n}\n');
    },
  },
];
const want = Number(arg('beans', '2'));
for (const b of beans.slice(0, want)) {
  run(['checkout', '-q', '-B', `bean/${b.name}`, 'origin/HEAD']);
  b.edit();
  run(['add', '-A']);
  run(['commit', '-qm', `Add ${b.name.replace('add-', '')}`]);
  const out = run(['push', '-o', 'wait', 'origin', `HEAD:refs/heads/bean/${b.name}`]);
  console.log(b.name, 'pushed');
  console.log(out.replaceAll(token, '<token>').slice(0, 600));
}
