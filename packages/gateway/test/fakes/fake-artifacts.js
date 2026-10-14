// A stand-in for the Artifacts binding (the RPC surface the gateway uses) and for the git
// remotes it hands out. Tests only: Artifacts has no local simulator. Repos live in module
// memory of this auxiliary worker; every test uses fresh run ids, so names never collide.
// Two namespaces, as deployed: races (FakeArtifacts, the ARTIFACTS binding) and people's
// repositories (FakeRepositories, the REPOS binding); each lists and deletes only its own.
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';

import { storeRealPack } from './fake-pack.js';
import { EMPTY_TREE, objectId, storeOf, storeTree } from './fake-store.js';

export { FakeRunner } from './fake-runner.js';

const HOST = 'https://acct.artifacts.test';
const PERSON = { name: 'fake', email: 'fake@beanstalk.invalid' };
const RACE_NAMESPACE = 'gitstalk-race';
const REPOS_NAMESPACE = 'gitstalk-repos';
const counter = { tokens: 0 };

function artifactsError(code, message) {
  const error = new Error(message);
  error.name = 'ArtifactsError';
  error.code = code;
  return error;
}

function newRepo(namespace, name, refs = new Map(), defaultBranch = 'main') {
  const repo = {
    name,
    namespace,
    remote: `${HOST}/git/${namespace}/${name}.git`,
    refs,
    defaultBranch,
    files: new Map(),
    tokens: [],
    // Git objects of pushes that carried a test payload: commits, trees and blobs by id.
    commits: new Map(),
    trees: new Map(),
    blobs: new Map(),
  };
  storeOf(namespace).set(name, repo);
  return repo;
}

function describe(repo) {
  const now = new Date(0).toISOString();
  return {
    id: repo.name,
    name: repo.name,
    description: null,
    defaultBranch: repo.defaultBranch,
    createdAt: now,
    updatedAt: now,
    lastPushAt: null,
    source: null,
    readOnly: false,
    remote: repo.remote,
  };
}

function branchRef(ref) {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

class FakeRepo extends RpcTarget {
  #repo;

  constructor(repo) {
    super();
    this.#repo = repo;
  }

  async info() {
    return describe(this.#repo);
  }

  async createToken(scope = 'write', ttl = 86400) {
    counter.tokens += 1;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    // The scope is visible in fake tokens only, so tests can see which scope a job got.
    const plaintext = `art_v1_${scope}_${counter.tokens.toString(16).padStart(32, '0')}?expires=${expires}`;
    this.#repo.tokens.push({ scope, plaintext });
    return {
      id: `token-${counter.tokens}`,
      plaintext,
      scope,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  async fork(target, options = {}) {
    if (storeOf(this.#repo.namespace).has(target))
      throw artifactsError('ALREADY_EXISTS', `${target} exists`);
    const keep = (ref) =>
      options.defaultBranchOnly === false
        ? ref.startsWith('refs/heads/')
        : ref === branchRef(this.#repo.defaultBranch);
    const fork = newRepo(
      this.#repo.namespace,
      target,
      new Map([...this.#repo.refs].filter(([ref]) => keep(ref))),
      this.#repo.defaultBranch,
    );
    return { ...describe(fork), token: 'art_v1_fork' };
  }

  async log(options = {}) {
    const start = resolveRef(this.#repo, options.ref ?? this.#repo.defaultBranch);
    if (start === undefined) return [];
    const history = [];
    let sha = start;
    while (sha !== undefined && history.length < (options.limit ?? 50) + (options.offset ?? 0)) {
      const commit = this.#repo.commits.get(sha);
      history.push(metadata(sha, commit));
      sha = commit?.parents[0];
    }
    return history.slice(options.offset ?? 0);
  }

  async readFile({ ref, path }) {
    const sha = resolveRef(this.#repo, ref);
    const stored = this.#repo.files.get(`${ref}\0${path}`);
    const content = stored ?? this.#repo.commits.get(sha ?? '')?.files[path];
    return content === undefined ? null : new Blob([content], { type: 'text/plain;charset=utf-8' });
  }

  async readBlob(hash) {
    const content = this.#repo.blobs.get(hash);
    return content === undefined ? null : new Blob([content]);
  }

  async readTree(hash) {
    return this.#repo.trees.get(hash) ?? null;
  }

  async readCommit(hash) {
    const commit = this.#repo.commits.get(hash);
    return commit === undefined ? null : metadata(hash, commit);
  }

  async listTokens() {
    return { tokens: [], total: this.#repo.tokens.length };
  }

  async revokeToken() {
    return true;
  }
}

export class FakeArtifacts extends WorkerEntrypoint {
  get namespace() {
    return RACE_NAMESPACE;
  }

  get #repos() {
    return storeOf(this.namespace);
  }

  async create(name, options = {}) {
    if (this.#repos.has(name)) throw artifactsError('ALREADY_EXISTS', `${name} exists`);
    const repo = newRepo(this.namespace, name, new Map(), options.setDefaultBranch ?? 'main');
    return { ...describe(repo), token: 'art_v1_create' };
  }

  async get(name) {
    const repo = this.#repos.get(name);
    if (repo === undefined) throw artifactsError('NOT_FOUND', `${name} not found`);
    return new FakeRepo(repo);
  }

  async delete(name) {
    return this.#repos.delete(name);
  }

  async list() {
    return { repos: [...this.#repos.values()].map(describe), total: this.#repos.size };
  }

  // Imports are faked for one URL shape: https://git.example.test/<anything>.git gives a repo
  // with one commit on `main` holding a README and a source file; anything else needs auth.
  async import({ source, target }) {
    if (!source.url.startsWith('https://git.example.test/'))
      throw artifactsError('REMOTE_AUTH_REQUIRED', 'imports are not faked for this URL');
    if (this.#repos.has(target.name))
      throw artifactsError('ALREADY_EXISTS', `${target.name} exists`);
    const repo = newRepo(this.namespace, target.name, new Map(), 'main');
    const files = { 'README.md': '# imported\n', 'src/index.ts': 'export {};\n' };
    const sha = objectId(`commit:${source.url}`);
    repo.commits.set(sha, {
      parents: [],
      message: 'imported',
      time: 0,
      files,
      tree: storeTree(repo, files),
    });
    repo.refs.set('refs/heads/main', sha);
    return { ...describe(repo), token: 'art_v1_import' };
  }
}

export class FakeRepositories extends FakeArtifacts {
  get namespace() {
    return REPOS_NAMESPACE;
  }
}

function resolveRef(repo, ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref : repo.refs.get(branchRef(ref));
}

function metadata(hash, commit) {
  return {
    hash,
    treeHash: commit?.tree ?? hash,
    message: commit?.message ?? '',
    author: PERSON,
    committer: PERSON,
    parents: commit?.parents ?? [],
    authoredAt: commit?.time ?? 0,
    committedAt: commit?.time ?? 0,
  };
}

/** A test-only pack: JSON after `PACK` describing commits (`{commits: {sha: {parents, files}}}`). */
function storePayload(repo, bytes) {
  const text = new TextDecoder().decode(bytes);
  const at = text.indexOf('0000PACK');
  const payload = at < 0 ? '' : text.slice(at + '0000PACK'.length);
  if (!payload.startsWith('{')) return;
  for (const [sha, commit] of Object.entries(JSON.parse(payload).commits ?? {})) {
    const files = commit.files ?? {};
    repo.commits.set(sha, {
      parents: commit.parents ?? [],
      message: commit.message ?? '',
      time: commit.time ?? 0,
      files,
      tree: storeTree(repo, files),
    });
  }
}

/** The pack after the commands' flush (empty when there is none). */
function packOf(bytes) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const at = text.indexOf('0000PACK');
  return at < 0 ? new Uint8Array(0) : bytes.subarray(at + 4);
}

/** Commands at the head of a receive-pack body: `<old> <new> <ref>` pkt-lines up to a flush. */
function pushCommands(bytes) {
  const text = new TextDecoder().decode(bytes);
  const commands = [];
  let offset = 0;
  while (offset + 4 <= text.length) {
    const length = Number.parseInt(text.slice(offset, offset + 4), 16);
    if (length === 0) break;
    const line = text
      .slice(offset + 4, offset + length)
      .split('\0')[0]
      .replace(/\n$/, '');
    const [oldSha, newSha, ref] = line.split(' ');
    commands.push({ oldSha, newSha, ref });
    offset += length;
  }
  return commands;
}

// The git remotes (every outbound fetch of the gateway lands here in tests): pushes update
// refs; every request is echoed back so tests can see what the proxy forwarded.
export class FakeGitRemote extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const match = /^\/git\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(url.pathname);
    const repo = match === null ? undefined : storeOf(match[1]).get(match[2]);
    if (repo === undefined) return new Response('no such repo', { status: 404 });
    const authorization = request.headers.get('authorization') ?? '';
    const token = authorization.replace(/^Bearer /, '');
    if (!repo.tokens.some((issued) => issued.plaintext === token))
      return new Response('bad token', { status: 401 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (speaksGit(request) && match[3] === 'info/refs') return advertise(repo, url);
    const commands = match[3] === 'git-receive-pack' ? pushCommands(bytes) : [];
    for (const command of commands) repo.refs.set(command.ref, command.newSha);
    if (commands.length > 0) storePayload(repo, bytes);
    // A real pack of a bean (automation saves, bean_commit) is read whole; the gateway's seed
    // packs stay unread, so a new repository's first commit is the known, empty one below.
    if (commands.some((command) => /^refs\/heads\/beans?\//.test(command.ref)))
      storeRealPack(repo, packOf(bytes));
    // A pack without objects (the first commit's ref updates) leaves a known, empty commit.
    for (const command of commands)
      if (!repo.commits.has(command.newSha) && command.newSha !== '0'.repeat(40))
        repo.commits.set(command.newSha, {
          parents: [],
          message: '',
          time: 0,
          files: {},
          tree: EMPTY_TREE,
        });
    if (speaksGit(request) && match[3] === 'git-receive-pack') return reportStatus(bytes, commands);
    return Response.json(
      {
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: authorization.slice(0, 'Bearer art_v1_'.length),
        scope: repo.tokens.find((issued) => issued.plaintext === token)?.scope ?? null,
        gitProtocol: request.headers.get('git-protocol'),
        bytes: bytes.length,
        commands,
      },
      { headers: { 'www-authenticate': 'Basic realm="artifacts"', 'x-upstream': 'fake' } },
    );
  }
}

// A real git client (or the gateway's own git client) gets real smart-HTTP answers: a ref
// advertisement and a report-status. Other test requests get the JSON echo above.
function speaksGit(request) {
  return (
    (request.headers.get('user-agent') ?? '').startsWith('git/') ||
    ((request.headers.get('content-type') ?? '').startsWith(
      'application/x-git-receive-pack-request',
    ) &&
      request.headers.get('accept') === 'application/x-git-receive-pack-result')
  );
}

function gitPkt(text) {
  const bytes = new TextEncoder().encode(text);
  return `${(bytes.length + 4).toString(16).padStart(4, '0')}${text}`;
}

function advertise(repo, url) {
  const service = url.searchParams.get('service');
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=fake-artifacts';
  const refs = [...repo.refs.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1));
  const lines =
    refs.length === 0
      ? [gitPkt(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`)]
      : refs.map(([ref, sha], index) => gitPkt(`${sha} ${ref}${index === 0 ? `\0${caps}` : ''}\n`));
  const body = `${gitPkt(`# service=${service}\n`)}0000${lines.join('')}0000`;
  return new Response(body, {
    headers: { 'content-type': `application/x-${service}-advertisement` },
  });
}

function reportStatus(bytes, commands) {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const sideband = /\0[^\n]*side-band-64k/.test(head);
  const report = `${gitPkt('unpack ok\n')}${commands.map((c) => gitPkt(`ok ${c.ref}\n`)).join('')}0000`;
  const body = sideband ? `${gitPkt(`\u0001${report}`)}0000` : report;
  return new Response(body, {
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
  });
}
