// A stand-in for the runner container's §3 API (packages/gateway/container), as a Durable Object the
// RUNNER binding points at in tests. Every squash and revert is clean, every suite green,
// every ref update accepted; each request body is kept so tests can inspect what the
// gateway sent. A squash is recorded in the fake trunk repo like the real runner's candidate
// (`recordSquash`), so a repository engine reads `.gitstalk/checks.yml` from its tree.
import { DurableObject } from 'cloudflare:workers';

import { recordRefUpdate, recordSquash } from './fake-store.js';

async function sha1(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class FakeRunner extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__requests')
      return Response.json((await this.ctx.storage.get('requests')) ?? []);
    if (url.pathname === '/__release') {
      gate(url.searchParams.get('bean') ?? '').release();
      return Response.json({ released: true });
    }
    // The wire contract it implements (RUNNER_API_VERSION in src/runner/runner-transport.ts).
    if (url.pathname === '/version')
      return Response.json({ version: 'fake', api_version: 4, git_sha: 'fake' });
    const body = await request.json();
    const requests = (await this.ctx.storage.get('requests')) ?? [];
    requests.push({ path: url.pathname, body });
    await this.ctx.storage.put('requests', requests);
    return Response.json(await answer(this, url.pathname, body), {
      status: url.pathname.startsWith('/v1/') ? 200 : 404,
    });
  }
}

async function answer(this_, path, body) {
  switch (path) {
    case '/v1/squash': {
      // A bean whose ref names `conflict` conflicts with the line once (then merges).
      if (
        body.change.ref.includes('conflict') &&
        (await firstTime(this_, `conflict:${body.change.ref}`))
      )
        return {
          result: 'conflict',
          files: ['src/shared.ts'],
          merge_base: body.change.base ?? body.onto,
          hunks: [
            {
              path: 'src/shared.ts',
              onto: 'export const total = 1;\n',
              change: 'export const total = 2;\n',
            },
          ],
        };
      const sha = await sha1(`${body.onto}:${body.change.ref}:${body.message}`);
      const changed = recordSquash({
        remote: body.repo,
        sha,
        onto: body.onto,
        changeRef: body.change.ref,
        message: body.message,
      });
      const files = [...new Set([`src/${body.change.ref.split('/').at(-1)}.ts`, ...changed])];
      SQUASHED.set(sha, body.change.ref);
      return {
        result: 'clean',
        sha,
        files,
        change_head: sha,
        merge_base: body.change.base ?? body.onto,
        ...(body.change.base === undefined ? {} : { change_files: files }),
      };
    }
    case '/v1/revert': {
      const sha = await sha1(`${body.onto}:revert:${body.commit}`);
      return { result: 'clean', sha, files: ['src/reverted.ts'] };
    }
    case '/v1/check': {
      const extra = Object.keys(body.extra_files ?? {});
      // The first check of a squash of a bean whose ref names `red` fails (its next push passes).
      const squashed = SQUASHED.get(body.sha) ?? '';
      // A bean whose ref names `held` stays in its check until a test releases it.
      if (squashed.includes('held')) await gate(squashed.split('/').at(-1)).held;
      if (squashed.includes('red') && (await firstTime(this_, `red:${squashed}`)))
        return redCheck(body.sha, [squashed, ...SQUASHED.values()].map(beanFile));
      return {
        sha: body.sha,
        green: true,
        tests: 1 + extra.length,
        failures: 0,
        failing_tests: [],
        failing_files: [],
        passing_files: extra,
        read_set: [],
        read_sets: {},
        read_depths: {},
        stack_files: [],
        output_excerpt: '',
        suite_seconds: 0.05,
        ci_seconds: 0.05,
        timed_out: false,
      };
    }
    case '/v1/update-ref':
      // The line moves in the trunk repo, as the real runner's push moves it, so reads of
      // `sprout` and `stalk` by name see what landed; a line a test planted elsewhere stays.
      recordRefUpdate({ remote: body.repo, ref: body.ref, from: body.old, sha: body.new });
      return { ok: true, actual: body.new };
    default:
      return { code: 'not_found', message: path };
  }
}

// Runner instances are separate objects (committer, sandboxes, CI) in one isolate: what one
// squashed and which first failures were served are shared here, as one repo would share them.
const SQUASHED = new Map();
const SEEN = new Set();

async function firstTime(_runner, key) {
  if (SEEN.has(key)) return false;
  SEEN.add(key);
  return true;
}

const GATES = new Map();

/** The gate of a held bean's checks: `held` resolves once a test released the bean. */
function gate(bean) {
  let found = GATES.get(bean);
  if (found === undefined) {
    let release = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    found = { held, release: () => release() };
    GATES.set(bean, found);
  }
  return found;
}

function beanFile(ref) {
  return `src/${ref.split('/').at(-1)}.ts`;
}

/** A red suite whose failing test reads the bean's own file and every file squashed before. */
function redCheck(sha, readSet) {
  return {
    sha,
    green: false,
    tests: 3,
    failures: 1,
    failing_tests: [
      { file: 'test/total.test.js', name: 'total adds tax', message: 'expected 110, got 100' },
    ],
    failing_files: ['test/total.test.js'],
    passing_files: [],
    read_set: [...new Set(readSet)],
    read_sets: { 'test/total.test.js': [...new Set(readSet)] },
    read_depths: {},
    stack_files: [],
    output_excerpt: 'not ok 1 - total adds tax\n  expected 110, got 100',
    suite_seconds: 0.05,
    ci_seconds: 0.05,
    timed_out: false,
  };
}
