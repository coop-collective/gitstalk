// Environments: one Gitstalk deployment per environment (staging, production, a self-hoster's
// own), generated from the tracked packages/*/wrangler.jsonc templates and one fork-owned
// directory per environment (docs/claude-opus/30-environments.md).
//
//   node scripts/environments.mjs generate  <env>              write packages/*/wrangler.<env>.jsonc
//   node scripts/environments.mjs provision <env>              create missing D1, KV, R2, queues; record
//                                                              their ids; generate missing secrets; migrate D1
//   node scripts/environments.mjs deploy    <env> [--only a,b] [--dry-run]
//   node scripts/environments.mjs verify    <env> --against <git ref>   generated == the ref's wrangler.jsonc
//   node scripts/environments.mjs smoke     <env> [--repo owner/name]   GITSTALK_TOKEN for whoami and clone
//   node scripts/environments.mjs secrets   <env> [--to-github owner/repo]   push Worker secrets
//                                                              (wrangler secret bulk), or store them in
//                                                              the GitHub secret GITSTALK_SECRETS_JSON
//
// environments/<env>/env.jsonc     hand-written: account, name prefix and suffix, workers.dev
//                                  subdomain, packages, custom URLs, per-package overrides
//                                  (see environments/example)
// environments/<env>/resources.json written by provision: resource ids and derived vars
// environments/<env>/secrets/<pkg>.vars  secret values (always git-ignored, never printed)
// GITSTALK_SECRETS_JSON            CI: the same values as {"<pkg>": {"NAME": "value"}} (never printed)
//
// The public repo ignores environments/* except example/; a fork commits its env.jsonc and
// resources.json with `git add -f` and never its secrets/.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every deployable package, in deploy order: a Worker deploys after the Workers it binds to. */
const ORDER = ['actions-executor', 'gateway', 'mcp', 'site', 'web', 'ssh'];

/**
 * The templates' name prefix. An environment's `prefix` (default "gitstalk") replaces it in every
 * Worker and resource name, so the old account's stack keeps its `beanstalk-*` names.
 */
const TEMPLATE_PREFIX = 'gitstalk';

/** Vars holding this environment's own origins: var name → [package, path appended]. */
const URL_VARS = {
  gateway: { PUBLIC_URL: ['gateway', ''], WEB_URL: ['web', ''] },
  mcp: { PUBLIC_URL: ['mcp', ''], WEB_URL: ['web', ''], GIT_ORIGIN: ['web', ''] },
  web: {
    GIT_ORIGIN: ['web', ''],
    WEB_URL: ['web', ''],
    MCP_URL: ['mcp', '/mcp'],
    DOCS_URL: ['site', '/docs/'],
  },
};

/** Secrets the code reads as optional but a deployment must have (Actions OIDC is on). */
const EXTRA_REQUIRED_SECRETS = { gateway: ['OIDC_REQUEST_SECRET', 'OIDC_SIGNING_KEYS'] };

/** Docker wrappers some container builds need (as in each package's `deploy` script). */
const DOCKER_BIN = {
  gateway: './container/docker-with-git-sha.sh',
};

/** R2 lifecycle rules applied when provision creates the bucket: bucket (no suffix) → days. */
const R2_EXPIRE_DAYS = { 'gitstalk-actions-logs': 30 };

/** The probe repository whose creation creates an Artifacts namespace (no namespace create). */
const PROBE_REPO = (verb) => ['artifacts', 'repos', verb, 'gitstalk-provision-probe'];

/** The GitHub environment secret CI reads Worker secrets from: {"<pkg>": {"NAME": "value"}}. */
const SECRETS_JSON = 'GITSTALK_SECRETS_JSON';

/** KV ids in the templates are `local-<namespace title>` placeholders. */
const LOCAL_ID = /^local-(.+)$/;

const [command, envName, ...rest] = process.argv.slice(2);
const COMMANDS = { generate, provision, deploy, verify, smoke, secrets };
if (!(command in COMMANDS) || !envName) {
  fail(`usage: node scripts/environments.mjs <${Object.keys(COMMANDS).join('|')}> <env> [options]`);
}
await COMMANDS[command](loadEnvironment(envName), rest);

// ---------------------------------------------------------------------------------------------
// Commands

function generate(env) {
  for (const pkg of env.packages) writeConfig(env, pkg, generateConfig(env, pkg));
  console.log(`generated ${env.packages.map((pkg) => configPath(env, pkg, true)).join(', ')}`);
}

async function provision(env) {
  const wanted = resourcesOf(env);
  const resources = env.resources;
  resources.d1 ??= {};
  resources.kv ??= {};

  const databases = new Map(
    JSON.parse(wrangler(env, ['d1', 'list', '--json'])).map((db) => [db.name, db.uuid]),
  );
  for (const name of wanted.d1) {
    if (!databases.has(name)) {
      wrangler(env, ['d1', 'create', name]);
      for (const db of JSON.parse(wrangler(env, ['d1', 'list', '--json'])))
        databases.set(db.name, db.uuid);
      console.log(`d1 ${name}: created`);
    } else console.log(`d1 ${name}: exists`);
    resources.d1[name] = databases.get(name);
  }

  const namespaces = () =>
    new Map(JSON.parse(wrangler(env, ['kv', 'namespace', 'list'])).map((ns) => [ns.title, ns.id]));
  let kv = namespaces();
  for (const title of wanted.kv) {
    if (!kv.has(title)) {
      wrangler(env, ['kv', 'namespace', 'create', title]);
      kv = namespaces();
      console.log(`kv ${title}: created`);
    } else console.log(`kv ${title}: exists`);
    resources.kv[title] = kv.get(title);
  }

  for (const [bucket, base] of wanted.r2) {
    if (wrangler(env, ['r2', 'bucket', 'info', bucket], { allowFailure: true }) === null) {
      wrangler(env, ['r2', 'bucket', 'create', bucket]);
      const days = R2_EXPIRE_DAYS[base];
      if (days)
        wrangler(env, [
          'r2',
          'bucket',
          'lifecycle',
          'add',
          bucket,
          'expire-logs',
          '--expire-days',
          String(days),
          '--force',
        ]);
      console.log(`r2 ${bucket}: created${days ? `, objects expire after ${days} days` : ''}`);
    } else console.log(`r2 ${bucket}: exists`);
  }

  for (const queue of wanted.queues) {
    if (wrangler(env, ['queues', 'info', queue], { allowFailure: true }) === null) {
      wrangler(env, ['queues', 'create', queue]);
      console.log(`queue ${queue}: created`);
    } else console.log(`queue ${queue}: exists`);
  }

  // Artifacts namespaces have no create command: the first repository creates one, so a probe
  // repository is created and deleted. A recently deleted namespace's name is refused ("not
  // active") for a while; that is reported, not fatal.
  for (const namespace of wanted.artifacts) {
    if (wrangler(env, ['artifacts', 'namespaces', 'get', namespace], { allowFailure: true }))
      console.log(`artifacts ${namespace}: exists`);
    else if (
      wrangler(env, [...PROBE_REPO('create'), '--namespace', namespace], { allowFailure: true })
    ) {
      wrangler(env, [...PROBE_REPO('delete'), '--namespace', namespace, '--force']);
      console.log(`artifacts ${namespace}: created`);
    } else
      console.warn(
        `artifacts ${namespace}: REFUSED (a deleted namespace's name stays unusable for a while); run provision again later`,
      );
  }

  saveResources(env);
  const generated = generateSecrets(env);
  saveResources(env);
  generate(env);
  await ensureAiGateway(env);
  ensureEmailSending(env);

  // Migrations: each database once, from the first package (in deploy order) that binds it.
  const migrated = new Set();
  for (const pkg of env.packages) {
    for (const db of generateConfig(env, pkg).d1_databases ?? []) {
      if (migrated.has(db.database_name) || !db.migrations_dir) continue;
      migrated.add(db.database_name);
      const output = wrangler(
        env,
        [
          'd1',
          'migrations',
          'apply',
          db.database_name,
          '--remote',
          '-c',
          configPath(env, pkg, false),
        ],
        { cwd: packageDir(pkg) },
      );
      const applied = new Set(output.match(/\d{4}_[\w-]+\.sql/g) ?? []).size;
      console.log(
        /No migrations to apply/.test(output)
          ? `d1 ${db.database_name}: migrations up to date`
          : `d1 ${db.database_name}: applied ${applied} migration(s)`,
      );
    }
  }
  console.log(`\nprovisioned ${env.name}; deploy with: pnpm env:deploy ${env.name}`);
  if (generated.length > 0) explainGeneratedSecrets(env, generated);
}

/**
 * New secret values exist only in environments/<env>/secrets/ (and on the Workers once
 * deployed). Says where to keep them for CI; never prints a value.
 */
function explainGeneratedSecrets(env, generated) {
  const names = generated.map((entry) => `${entry.pkg}: ${entry.names.join(', ')}`).join('; ');
  if (process.env.CI) {
    console.warn(
      `\nwarning: generated ${names} on this runner; they go up with this deploy and stay on the Workers, but are not in ${SECRETS_JSON}. To keep a copy, rotate them from the owner's machine (provision there, then pnpm env:secrets ${env.name} --to-github <owner/repo>).`,
    );
    return;
  }
  console.log(
    `\ngenerated ${names} in ${path.relative(ROOT, path.join(env.dir, 'secrets'))}/ (mode 0600).\n` +
      `CI reads them from the GitHub environment secret ${SECRETS_JSON}; store them there without printing them:\n` +
      `  pnpm env:secrets ${env.name} --to-github <owner>/<deploy-repo>\n` +
      `Keep a backup of that directory: ACTIONS_SECRETS_KEY cannot be recovered from the Workers.`,
  );
}

/**
 * Pushes every secret this environment holds (GITSTALK_SECRETS_JSON or secrets/<pkg>.vars) to
 * its Worker with `wrangler secret bulk` (values on stdin, never on a command line or in a
 * log). A Worker that does not exist yet gets its secrets with its first deploy instead
 * (deploy uploads them with the version). With --to-github, stores them in the GitHub
 * environment secret GITSTALK_SECRETS_JSON through `gh secret set` instead (owner's machine).
 */
function secrets(env, args) {
  const repo = valueOf(args, '--to-github');
  if (repo) return secretsToGithub(env, repo);
  let pushed = 0;
  for (const pkg of env.packages) {
    const values = readSecrets(env, pkg);
    if (values.size === 0) continue;
    const worker = generateConfig(env, pkg, { allowMissingIds: true }).name;
    if (remoteSecrets(env, worker) === null) {
      console.log(
        `${worker}: not deployed yet; ${values.size} secret(s) go up with its first deploy`,
      );
      continue;
    }
    const result = spawnSync(wranglerBin('gateway'), ['secret', 'bulk', '--name', worker], {
      cwd: env.dir,
      env: wranglerEnv(env),
      input: JSON.stringify(Object.fromEntries(values)),
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (result.status !== 0) fail(`wrangler secret bulk failed for ${worker}`);
    pushed += values.size;
    console.log(`${worker}: set ${[...values.keys()].join(', ')}`);
  }
  console.log(`\n${env.name}: ${pushed} secret(s) pushed`);
  const missing = missingSecrets(env, env.packages);
  if (missing.length > 0)
    console.warn(
      `still missing (deploy will refuse): ${missing.map(({ pkg, name }) => `${pkg} ${name}`).join(', ')}`,
    );
}

/** Stores the local secrets files as GITSTALK_SECRETS_JSON in a GitHub environment. */
function secretsToGithub(env, repo) {
  if (process.env.CI) fail('--to-github runs on the owner’s machine, never in CI');
  if (!existsSync(path.join(env.dir, 'secrets')))
    fail(`no ${path.relative(ROOT, path.join(env.dir, 'secrets'))}/ to store`);
  const all = {};
  for (const pkg of env.packages) {
    const values = readSecretsFile(env, pkg);
    if (values.size > 0) all[pkg] = Object.fromEntries(values);
  }
  if (Object.keys(all).length === 0) fail(`no secrets in environments/${env.name}/secrets/`);
  const result = spawnSync(
    'gh',
    ['secret', 'set', SECRETS_JSON, '--env', env.name, '--repo', repo],
    { input: JSON.stringify(all), encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) fail('gh secret set failed');
  const count = Object.values(all).reduce((sum, values) => sum + Object.keys(values).length, 0);
  console.log(
    `${repo} (${env.name}): ${SECRETS_JSON} holds ${count} secret(s) for ${Object.keys(all).join(', ')}`,
  );
}

/**
 * Automations call Workers AI through the AI Gateway named in AUTOMATIONS_AI_GATEWAY (and the
 * Jev picker through JEV_GATEWAY). Creates it when an API token can (CLOUDFLARE_API_TOKEN with
 * AI Gateway edit); otherwise says so, as Wrangler has no AI Gateway command.
 */
async function ensureAiGateway(env) {
  const names = new Set();
  for (const pkg of env.packages) {
    const vars = generateConfig(env, pkg, { allowMissingIds: true }).vars ?? {};
    for (const key of ['AUTOMATIONS_AI_GATEWAY', 'JEV_GATEWAY'])
      if (vars[key]) names.add(vars[key]);
  }
  if (names.size === 0) return;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.log(
      `ai gateway ${[...names].join(', ')}: not checked (needs CLOUDFLARE_API_TOKEN with AI Gateway edit); the dashboard creates it under AI → AI Gateway`,
    );
    return;
  }
  const api = `https://api.cloudflare.com/client/v4/accounts/${env.account_id}/ai-gateway/gateways`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const ensure = async (id) => {
    if ((await fetch(`${api}/${id}`, { headers })).ok) return `ai gateway ${id}: exists`;
    const created = await fetch(api, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id,
        cache_ttl: 0,
        cache_invalidate_on_update: false,
        collect_logs: true,
        rate_limiting_interval: 0,
        rate_limiting_limit: 0,
        rate_limiting_technique: 'fixed',
      }),
    });
    return created.ok
      ? `ai gateway ${id}: created`
      : `ai gateway ${id}: could not create (HTTP ${created.status}; the token needs AI Gateway edit); create it in the dashboard`;
  };
  for (const line of await Promise.all([...names].map(ensure))) console.log(line);
}

/**
 * Email sign-in sends from signin@<EMAIL_SENDER_DOMAIN> (the web's var) through Cloudflare Email
 * Sending, which needs the domain onboarded (SPF, DKIM and a bounce MX, added to the zone by
 * `wrangler email sending enable`). Onboards it when it is not yet; says what to do otherwise.
 */
function ensureEmailSending(env) {
  if (!env.packages.includes('web')) return;
  const domain = generateConfig(env, 'web', { allowMissingIds: true }).vars?.EMAIL_SENDER_DOMAIN;
  if (!domain) {
    console.log('email sending: off (no EMAIL_SENDER_DOMAIN in overrides.web.vars)');
    return;
  }
  const isEnabled = () =>
    (wrangler(env, ['email', 'sending', 'list'], { allowFailure: true }) ?? '')
      .split('\n')
      .some((row) => new RegExp(`│\\s*${domain.replace(/\./g, '\\.')}\\s*│\\s*yes\\s*│`).test(row));
  if (isEnabled()) {
    console.log(`email sending ${domain}: enabled`);
    return;
  }
  wrangler(env, ['email', 'sending', 'enable', domain], { allowFailure: true });
  console.log(
    isEnabled()
      ? `email sending ${domain}: enabled now (DNS records added; allow a few minutes)`
      : `email sending ${domain}: NOT enabled; onboard it in the dashboard (Compute & AI → Email Service → Email Sending → Onboard Domain) or with \`wrangler email sending enable ${domain}\``,
  );
}

function deploy(env, args) {
  const dryRun = args.includes('--dry-run');
  const only = valueOf(args, '--only')?.split(',') ?? env.packages;
  const unknown = only.filter((pkg) => !env.packages.includes(pkg));
  if (unknown.length > 0) fail(`not in ${env.name}'s packages: ${unknown.join(', ')}`);
  const selected = env.packages.filter((pkg) => only.includes(pkg));

  const configs = new Map(selected.map((pkg) => [pkg, generateConfig(env, pkg)]));
  const missing = missingSecrets(env, selected);
  if (missing.length > 0) {
    const lines = missing.map(({ pkg, name }) => `  ${pkg}: ${name}`).join('\n');
    const message = `missing secrets in ${env.name}:\n${lines}\nset them with \`pnpm env:provision ${env.name}\` (generates new values) or \`wrangler secret put <NAME> --name <worker>\``;
    if (!dryRun) fail(message);
    console.warn(`warning (dry run): ${message}`);
  }
  if (!dryRun && selected.some((pkg) => configs.get(pkg).containers)) requireDocker();

  // First deploy of an environment: the executor and the gateway bind each other, and Cloudflare
  // refuses a service binding to a Worker that does not exist yet. A Worker whose bound Worker
  // is missing goes up once without that binding, then again, whole, after everything else.
  const exists = new Set();
  const isUp = (worker) => {
    if (dryRun || exists.has(worker)) return true;
    return remoteSecrets(env, worker) !== null;
  };
  const again = [];
  const urls = {};
  for (const pkg of selected) {
    const config = configs.get(pkg);
    const absent = (config.services ?? []).filter(
      (service) => service.service.endsWith(env.suffix) && !isUp(service.service),
    );
    if (absent.length > 0) {
      const names = absent.map((service) => service.binding);
      console.log(`\n${config.name}: first deploy without ${names.join(', ')} (not deployed yet)`);
      writeConfig(env, pkg, {
        ...config,
        services: config.services.filter((service) => !names.includes(service.binding)),
      });
      again.push(pkg);
    } else writeConfig(env, pkg, config);
    urls[pkg] = deployPackage(env, pkg, { dryRun });
    exists.add(config.name);
  }
  for (const pkg of again) {
    writeConfig(env, pkg, configs.get(pkg));
    urls[pkg] = deployPackage(env, pkg, { dryRun });
  }
  console.log(`\n== ${env.name}${dryRun ? ' (dry run)' : ''}`);
  for (const pkg of selected)
    console.log(`${configs.get(pkg).name}: ${dryRun ? 'checked' : (urls[pkg] ?? 'deployed')}`);
}

function verify(env, args) {
  const ref = valueOf(args, '--against') ?? fail('verify needs --against <git ref>');
  let differences = 0;
  for (const pkg of ORDER) {
    const show = spawnSync('git', ['show', `${ref}:packages/${pkg}/wrangler.jsonc`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (show.status !== 0) {
      console.log(`${pkg}: not in ${ref}, skipped`);
      continue;
    }
    const expected = parseJsonc(show.stdout);
    const actual = generateConfig(env, pkg, { allowMissingIds: false });
    delete actual.account_id; // the generated config pins the account; the old one did not
    const diffs = diff(expected, actual, '');
    differences += diffs.length;
    console.log(diffs.length === 0 ? `${pkg}: identical` : `${pkg}: DIFFERENT`);
    for (const line of diffs) console.log(`  ${line}`);
  }
  if (differences > 0) fail(`${differences} difference(s) from ${ref}`);
  console.log(`\nevery generated ${env.name} config equals ${ref}'s wrangler.jsonc`);
}

async function smoke(env, args) {
  const url = (pkg) => originOf(env, pkg);
  const results = [];
  const check = async (label, test) => {
    try {
      const detail = await test();
      results.push(true);
      console.log(`ok   ${label}${detail ? `: ${detail}` : ''}`);
    } catch (error) {
      results.push(false);
      console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await check(`gateway ${url('gateway')}/healthz`, async () => {
    const { status } = await get(`${url('gateway')}/healthz`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
  });
  await check(`web ${url('web')}/signup`, async () => {
    const { status, body } = await get(`${url('web')}/signup`);
    if (status !== 200 || !body.includes('passkey')) throw new Error(`HTTP ${status}`);
  });
  const emailDomain = generateConfig(env, 'web', { allowMissingIds: true }).vars
    ?.EMAIL_SENDER_DOMAIN;
  await check(`web ${url('web')}/login (email sign-in ${emailDomain ? 'on' : 'off'})`, async () => {
    const { status, body } = await get(`${url('web')}/login`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (body.includes('Continue with email') !== Boolean(emailDomain))
      throw new Error(`the email form is ${emailDomain ? 'missing' : 'shown'}`);
  });
  if (env.packages.includes('mcp'))
    await check(`mcp ${url('mcp')}/.well-known/oauth-authorization-server`, async () => {
      const { status, body } = await get(`${url('mcp')}/.well-known/oauth-authorization-server`);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return `issuer ${JSON.parse(body).issuer}`;
    });
  await check(`web ${url('web')}/robots.txt and /sitemap.xml`, async () => {
    const robots = await get(`${url('web')}/robots.txt`);
    const sitemap = await get(`${url('web')}/sitemap.xml`);
    if (robots.status !== 200 || sitemap.status !== 200)
      throw new Error(`HTTP ${robots.status} and ${sitemap.status}`);
    const indexed = robots.body.includes(`Sitemap: ${url('web')}/sitemap.xml`);
    if (indexed !== (env.search_indexing === true))
      throw new Error(`robots.txt does not match search_indexing ${env.search_indexing === true}`);
    if (!sitemap.body.includes(`<loc>${url('web')}/signup</loc>`))
      throw new Error('sitemap.xml does not list /signup on this origin');
    return indexed ? 'indexed' : 'noindex';
  });
  if (env.packages.includes('site'))
    await check(`site ${url('site')}/docs/`, async () => {
      const { status } = await get(`${url('site')}/docs/`);
      if (status !== 200) throw new Error(`HTTP ${status}`);
    });
  const token = setting('TOKEN');
  if (!token) console.log('skip whoami and clone: set GITSTALK_TOKEN to a personal token');
  else {
    await check('whoami with a token', async () => {
      const { status, body } = await get(`${url('gateway')}/v1/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const who = JSON.parse(body);
      return `${who.kind} ${who.handle}`;
    });
    const repo = valueOf(args, '--repo');
    if (repo)
      await check(`git clone ${url('web')}/${repo}.git`, () => {
        const into = mkdtempSync(path.join(os.tmpdir(), 'gitstalk-smoke-'));
        try {
          // The token rides in the environment (GIT_CONFIG_*), never on a command line.
          const clone = spawnSync(
            'git',
            ['clone', '--quiet', `${url('web')}/${repo}.git`, path.join(into, 'repo')],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_CONFIG_COUNT: '2',
                GIT_CONFIG_KEY_0: 'credential.helper',
                GIT_CONFIG_VALUE_0: '',
                GIT_CONFIG_KEY_1: 'http.extraHeader',
                GIT_CONFIG_VALUE_1: `Authorization: Bearer ${token}`,
              },
            },
          );
          if (clone.status !== 0) throw new Error(clone.stderr.trim().split('\n').pop());
          const head = spawnSync(
            'git',
            ['-C', path.join(into, 'repo'), 'status', '--short', '-b'],
            {
              encoding: 'utf8',
            },
          );
          return head.stdout.trim().split('\n')[0];
        } finally {
          rmSync(into, { recursive: true, force: true });
        }
      });
  }
  if (results.includes(false)) fail('smoke test failed');
}

// ---------------------------------------------------------------------------------------------
// Configuration

function loadEnvironment(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`environment names are lowercase words: ${name}`);
  const dir = path.join(ROOT, 'environments', name);
  const file = path.join(dir, 'env.jsonc');
  const resourcesFile = path.join(dir, 'resources.json');
  const fromFile = existsSync(file);
  const configText = fromFile ? readFileSync(file, 'utf8') : setting('ENV_CONFIG');
  if (!configText)
    fail(
      `no ${path.relative(ROOT, file)} and no GITSTALK_ENV_CONFIG: copy environments/example/env.jsonc and fill it in, or put its contents in that variable`,
    );
  const resourcesText = existsSync(resourcesFile)
    ? readFileSync(resourcesFile, 'utf8')
    : setting('ENV_RESOURCES');
  const resources = resourcesText ? JSON.parse(resourcesText) : {};
  const env = { ...parseJsonc(configText), ...scalarOverrides() };
  if (!/^[0-9a-f]{32}$/.test(env.account_id ?? ''))
    fail(`${name}: account_id must be the 32-character account id (wrangler whoami)`);
  if (typeof env.suffix !== 'string') fail(`${name}: suffix is required ("" keeps the base names)`);
  if (env.search_indexing !== undefined && typeof env.search_indexing !== 'boolean')
    fail(`${name}: search_indexing is true (production) or false (the default)`);
  env.prefix ??= TEMPLATE_PREFIX;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(env.prefix))
    fail(`${name}: prefix is a lowercase word such as "gitstalk" (the default) or "beanstalk"`);
  if (!env.workers_dev_subdomain && !env.urls)
    fail(`${name}: set workers_dev_subdomain (or urls for every package that serves one)`);
  const unknown = (env.packages ?? []).filter((pkg) => !ORDER.includes(pkg));
  if (unknown.length > 0) fail(`${name}: unknown package(s) ${unknown.join(', ')}`);
  return {
    ...env,
    name,
    dir,
    fromFile,
    resources,
    packages: ORDER.filter((pkg) => (env.packages ?? []).includes(pkg)),
    overrides: env.overrides ?? {},
  };
}

/** The package's template with this environment's names, ids, origins and overrides. */
function generateConfig(env, pkg, { allowMissingIds = false } = {}) {
  const config = parseJsonc(readFileSync(path.join(packageDir(pkg), 'wrangler.jsonc'), 'utf8'));
  const named = (name) => nameIn(env, name);
  const missing = [];
  const idOf = (kind, name) => {
    const id = env.resources[kind]?.[name];
    if (!id) missing.push(`${kind} ${name}`);
    return id ?? `missing-${name}`;
  };

  config.account_id = env.account_id;
  config.name = named(config.name);
  for (const service of config.services ?? [])
    if (service.service.startsWith(`${TEMPLATE_PREFIX}-`)) service.service = named(service.service);
  // The site on the web's own origin: the web forwards the site's paths over this binding
  // (packages/web/worker/index.ts), and the site gets no hostname of its own.
  if (pkg === 'web' && siteServedByWeb(env))
    config.services = [...(config.services ?? []), { binding: 'SITE', service: named(siteName()) }];
  for (const db of config.d1_databases ?? []) {
    db.database_name = named(db.database_name);
    db.database_id = idOf('d1', db.database_name);
  }
  for (const ns of config.kv_namespaces ?? []) {
    const title = LOCAL_ID.exec(ns.id)?.[1];
    if (!title) fail(`${pkg}: kv_namespaces ids in wrangler.jsonc must be local-<title>`);
    ns.id = idOf('kv', named(title));
  }
  for (const bucket of config.r2_buckets ?? []) bucket.bucket_name = named(bucket.bucket_name);
  for (const queue of [...(config.queues?.producers ?? []), ...(config.queues?.consumers ?? [])])
    queue.queue = named(queue.queue);
  for (const artifacts of config.artifacts ?? []) artifacts.namespace = named(artifacts.namespace);
  for (const dataset of config.analytics_engine_datasets ?? [])
    dataset.dataset = `${dataset.dataset}${env.suffix.replaceAll('-', '_')}`;

  const vars = config.vars ?? {};
  if ('ARTIFACTS_NAMESPACE' in vars) vars.ARTIFACTS_NAMESPACE = named(vars.ARTIFACTS_NAMESPACE);
  for (const [name, [target, suffix]] of Object.entries(URL_VARS[pkg] ?? {}))
    if (name in vars) vars[name] = `${originOf(env, target)}${suffix}`;
  for (const [name, value] of Object.entries(env.resources.vars ?? {}))
    if (name in vars) vars[name] = value;
  // Search engines index only an environment that says so (production); every other one is
  // noindex with a Disallow-all robots.txt (packages/web/src/site/search.ts).
  if ('SEARCH_INDEXING' in vars) vars.SEARCH_INDEXING = env.search_indexing === true ? 'on' : 'off';

  const domain = customDomainOf(env, pkg);
  if (domain) config.routes = [{ pattern: domain, custom_domain: true }];

  if (missing.length > 0 && !allowMissingIds)
    fail(`${env.name}: no id for ${missing.join(', ')}; run pnpm env:provision ${env.name}`);
  return merge(config, env.overrides[pkg] ?? {});
}

/** A template name (`gitstalk-gateway`) in this environment: its prefix, then its suffix. */
function nameIn(env, name) {
  const base = name.startsWith(`${TEMPLATE_PREFIX}-`)
    ? `${env.prefix}${name.slice(TEMPLATE_PREFIX.length)}`
    : name;
  return `${base}${env.suffix}`;
}

function siteName() {
  return parseJsonc(readFileSync(path.join(packageDir('site'), 'wrangler.jsonc'), 'utf8')).name;
}

/** Whether the site and the web share one origin (`urls.site` equals `urls.web`). */
function siteServedByWeb(env) {
  return (
    env.packages.includes('site') &&
    env.packages.includes('web') &&
    Boolean(env.urls?.site) &&
    originOf(env, 'site') === originOf(env, 'web')
  );
}

/**
 * The hostname a package's Worker is attached to as a Workers Custom Domain: the host of its
 * `urls.<pkg>` when that is a bare https origin outside workers.dev. The site has none when
 * the web serves it. Provision and deploy attach it (Wrangler creates the DNS record and the
 * certificate); the zone must be on the environment's account.
 */
function customDomainOf(env, pkg) {
  const custom = env.urls?.[pkg];
  if (!custom || (pkg === 'site' && siteServedByWeb(env))) return null;
  const url = new URL(custom);
  if (url.protocol !== 'https:' || url.hostname.endsWith('.workers.dev')) return null;
  if (url.pathname !== '/' && url.pathname !== '')
    fail(`${env.name}: urls.${pkg} must be an origin (no path) to become a custom domain`);
  return url.hostname;
}

/** A package's public origin: a custom URL from env.jsonc, else its workers.dev address. */
function originOf(env, pkg) {
  const custom = env.urls?.[pkg];
  if (custom) return custom.replace(/\/$/, '');
  const template = parseJsonc(readFileSync(path.join(packageDir(pkg), 'wrangler.jsonc'), 'utf8'));
  return `https://${nameIn(env, template.name)}.${env.workers_dev_subdomain}.workers.dev`;
}

/** Every resource the environment's packages bind, by its environment name. */
function resourcesOf(env) {
  const out = {
    d1: new Set(),
    kv: new Set(),
    r2: new Map(),
    queues: new Set(),
    artifacts: new Set(),
  };
  for (const pkg of env.packages) {
    const template = parseJsonc(readFileSync(path.join(packageDir(pkg), 'wrangler.jsonc'), 'utf8'));
    const config = generateConfig(env, pkg, { allowMissingIds: true });
    for (const db of config.d1_databases ?? []) out.d1.add(db.database_name);
    for (const ns of template.kv_namespaces ?? [])
      out.kv.add(nameIn(env, LOCAL_ID.exec(ns.id)?.[1] ?? ''));
    for (const [index, bucket] of (config.r2_buckets ?? []).entries())
      out.r2.set(bucket.bucket_name, template.r2_buckets[index]?.bucket_name);
    for (const queue of config.queues?.producers ?? []) out.queues.add(queue.queue);
    for (const artifacts of config.artifacts ?? []) out.artifacts.add(artifacts.namespace);
  }
  return out;
}

function packageDir(pkg) {
  return path.join(ROOT, 'packages', pkg);
}

/** packages/<pkg>/wrangler.<env>.jsonc, beside the template so relative paths still resolve. */
function configPath(env, pkg, fromRoot) {
  const file = `wrangler.${env.name}.jsonc`;
  return fromRoot ? path.join('packages', pkg, file) : file;
}

function writeConfig(env, pkg, config) {
  const header =
    `// Generated by scripts/environments.mjs from wrangler.jsonc and environments/${env.name}/.\n` +
    '// Do not edit: change the template or the environment and run generate again.\n';
  writeFileSync(
    path.join(packageDir(pkg), configPath(env, pkg, false)),
    `${header}${JSON.stringify(config, null, 2)}\n`,
  );
}

function saveResources(env) {
  const json = `${JSON.stringify(env.resources, null, 2)}\n`;
  if (!env.fromFile) {
    // Configured from variables (a soft fork's CI): nothing on disk to update, so hand the ids
    // back for the GITSTALK_ENV_RESOURCES variable. Ids, not secrets.
    console.log(`environments: ${env.name}: set GITSTALK_ENV_RESOURCES to:\n${json}`);
    return;
  }
  writeFileSync(path.join(env.dir, 'resources.json'), json);
}

/**
 * Single values a soft fork sets as plain variables instead of committing env.jsonc; each one
 * replaces the same key from the file or GITSTALK_ENV_CONFIG.
 */
function scalarOverrides() {
  const out = {};
  const accountId = setting('ACCOUNT_ID');
  if (accountId) out.account_id = accountId;
  // Defined, even empty, is a choice: "" means the base (production) names.
  const suffix = process.env.GITSTALK_SUFFIX ?? process.env.BEANSTALK_SUFFIX;
  if (suffix !== undefined) out.suffix = suffix;
  const subdomain = setting('WORKERS_DEV_SUBDOMAIN');
  if (subdomain) out.workers_dev_subdomain = subdomain;
  return out;
}

/**
 * A setting from the environment: GITSTALK_<name>, else BEANSTALK_<name> as it was called before
 * the rename (2026-10-10). Empty counts as unset, as an unset GitHub variable arrives empty.
 */
function setting(name) {
  return process.env[`GITSTALK_${name}`] || process.env[`BEANSTALK_${name}`] || undefined;
}

// ---------------------------------------------------------------------------------------------
// Secrets: names are printed, values never.

function requiredSecrets(pkg) {
  const template = parseJsonc(readFileSync(path.join(packageDir(pkg), 'wrangler.jsonc'), 'utf8'));
  return [...(template.secrets?.required ?? []), ...(EXTRA_REQUIRED_SECRETS[pkg] ?? [])];
}

function secretsFile(env, pkg) {
  return path.join(env.dir, 'secrets', `${pkg}.vars`);
}

/**
 * A package's secret values: secrets/<pkg>.vars, with GITSTALK_SECRETS_JSON's (CI, a GitHub
 * environment secret) taking precedence.
 */
function readSecrets(env, pkg) {
  const values = readSecretsFile(env, pkg);
  for (const [name, value] of Object.entries(secretsJson(env)[pkg] ?? {}))
    if (typeof value === 'string' && value) values.set(name, value);
  return values;
}

/** GITSTALK_SECRETS_JSON parsed once: {"<pkg>": {"NAME": "value"}}; {} when unset. */
function secretsJson(env) {
  if (env.secretsJson) return env.secretsJson;
  const text = process.env[SECRETS_JSON];
  if (!text) return (env.secretsJson = {});
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) throw new Error('not an object');
    return (env.secretsJson = parsed);
  } catch {
    // Never echo the text: it is the secrets.
    return fail(`${SECRETS_JSON} is not JSON of the form {"<package>": {"NAME": "value"}}`);
  }
}

/** NAME=value lines; a double-quoted value may hold \n escapes (an SSH key). */
function readSecretsFile(env, pkg) {
  const file = secretsFile(env, pkg);
  if (!existsSync(file)) return new Map();
  const values = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2];
    const value = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'|'$/g, '');
    if (value) values.set(match[1], value);
  }
  return values;
}

function appendSecrets(env, pkg, entries) {
  const file = secretsFile(env, pkg);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${existing}${separator}${lines.join('\n')}\n`);
  chmodSync(file, 0o600);
}

/** The Worker's secret names, or null when the Worker does not exist yet. */
function remoteSecrets(env, workerName) {
  const result = spawnSync(
    wranglerBin('gateway'),
    ['secret', 'list', '--name', workerName, '--format', 'json'],
    { cwd: env.dir, encoding: 'utf8', env: wranglerEnv(env), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status === 0) return new Set(JSON.parse(result.stdout).map((secret) => secret.name));
  if (/not found/.test(result.stderr)) return null;
  return fail(`could not list ${workerName}'s secrets (wrangler secret list failed)`);
}

function missingSecrets(env, packages) {
  const missing = [];
  for (const pkg of packages) {
    const required = requiredSecrets(pkg);
    if (required.length === 0) continue;
    const local = readSecrets(env, pkg);
    const remote = remoteSecrets(env, generateConfig(env, pkg).name) ?? new Set();
    for (const name of required)
      if (!local.has(name) && !remote.has(name)) missing.push({ pkg, name });
  }
  return missing;
}

/**
 * Generates a value for every required secret that is neither in the local secrets file nor
 * already set on the Worker: an existing secret is never replaced (rotating ACTIONS_SECRETS_KEY
 * would make every stored Actions secret unreadable).
 */
function generateSecrets(env) {
  const generated = [];
  for (const pkg of env.packages) {
    const required = requiredSecrets(pkg);
    if (required.length === 0) continue;
    const local = readSecrets(env, pkg);
    const remote = remoteSecrets(env, generateConfig(env, pkg, { allowMissingIds: true }).name);
    const absent = required.filter((name) => !local.has(name) && !remote?.has(name));
    if (absent.length === 0) continue;
    appendSecrets(
      env,
      pkg,
      absent.map((name) => [name, newSecret(env, name)]),
    );
    console.log(
      `${pkg}: generated ${absent.join(', ')} in ${path.relative(ROOT, secretsFile(env, pkg))}`,
    );
    generated.push({ pkg, names: absent });
  }
  return generated;
}

function newSecret(env, name) {
  if (name === 'ACTIONS_SECRETS_KEY') return randomBytes(32).toString('base64');
  if (name === 'OIDC_SIGNING_KEYS') {
    const script = path.join(ROOT, 'packages/shared-oidc/scripts/oidc-keys.mjs');
    const keys = spawnSync(process.execPath, [script, 'new'], { encoding: 'utf8' });
    if (keys.status !== 0) fail('oidc-keys.mjs failed');
    return keys.stdout.trim();
  }
  if (name === 'SSH_HOST_KEY') {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gitstalk-ssh-'));
    try {
      const key = path.join(dir, 'host');
      const made = spawnSync(
        'ssh-keygen',
        ['-q', '-t', 'ed25519', '-N', '', '-C', `gitstalk-${env.name}`, '-f', key],
        { stdio: 'ignore' },
      );
      if (made.status !== 0) fail('ssh-keygen failed');
      const print = spawnSync('ssh-keygen', ['-lf', `${key}.pub`], { encoding: 'utf8' });
      env.resources.vars ??= {};
      env.resources.vars.SSH_HOST_KEY_FINGERPRINT = /SHA256:\S+/.exec(print.stdout)?.[0] ?? '';
      return readFileSync(key, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------------------------
// Wrangler

function wranglerBin(pkg) {
  return path.join(packageDir(pkg), 'node_modules', '.bin', 'wrangler');
}

function wranglerEnv(env) {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: env.account_id };
}

/** Runs Wrangler (resource commands in the environment's directory, where no config is found). */
function wrangler(env, args, { cwd = env.dir, allowFailure = false } = {}) {
  mkdirSync(cwd, { recursive: true });
  const result = spawnSync(wranglerBin('gateway'), args, {
    cwd,
    encoding: 'utf8',
    env: wranglerEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return result.stdout;
  if (allowFailure) return null;
  process.stderr.write(result.stderr ?? '');
  return fail(`wrangler ${args.slice(0, 3).join(' ')} failed`);
}

function deployPackage(env, pkg, { dryRun }) {
  const cwd = packageDir(pkg);
  const config = configPath(env, pkg, false);
  console.log(`\n== ${pkg}${dryRun ? ' (dry run)' : ''}`);
  const childEnv = { ...wranglerEnv(env) };
  if (DOCKER_BIN[pkg]) childEnv.WRANGLER_DOCKER_BIN = DOCKER_BIN[pkg];
  let deployConfig = config;
  if (pkg === 'web') {
    // vite.config.ts hands GITSTALK_WRANGLER_CONFIG to the Cloudflare plugin, which writes
    // the deployable config to dist/server/wrangler.json.
    run('pnpm', ['build'], { cwd, env: { ...childEnv, GITSTALK_WRANGLER_CONFIG: config } });
    deployConfig = 'dist/server/wrangler.json';
  }
  const args = ['deploy', '--config', deployConfig];
  if (dryRun) args.push('--dry-run');
  const values = dryRun ? new Map() : readSecrets(env, pkg);
  const tmp = values.size > 0 ? mkdtempSync(path.join(os.tmpdir(), 'gitstalk-secrets-')) : null;
  try {
    if (tmp !== null) {
      const file = path.join(tmp, 'secrets.json');
      writeFileSync(file, JSON.stringify(Object.fromEntries(values)), { mode: 0o600 });
      args.push('--secrets-file', file);
    }
    const output = run(wranglerBin(pkg), args, { cwd, env: childEnv });
    return /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0] ?? null;
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs a command, echoing its output, and returns its stdout; exits on failure. */
function run(program, args, { cwd, env }) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(result.stdout ?? '');
  if (result.status !== 0)
    fail(`${path.basename(program)} ${args.slice(0, 2).join(' ')} failed in ${cwd}`);
  return result.stdout ?? '';
}

function requireDocker() {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0)
    fail('container images are built with Docker: start Docker first');
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function get(target, init) {
  const response = await fetch(target, init);
  return { status: response.status, body: await response.text() };
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Objects merge key by key; arrays of objects merge by their identity key; anything else replaces. */
function merge(base, override) {
  if (Array.isArray(base) && Array.isArray(override)) {
    const key = ['class_name', 'binding', 'name', 'queue'].find((candidate) =>
      override.every((item) => isObject(item) && candidate in item),
    );
    if (!key) return override;
    const out = base.map((item) => {
      const match = override.find((candidate) => candidate[key] === item[key]);
      return match ? merge(item, match) : item;
    });
    for (const item of override) if (!base.some((b) => b[key] === item[key])) out.push(item);
    return out;
  }
  if (isObject(base) && isObject(override)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override))
      out[key] = key in base ? merge(base[key], value) : value;
    return out;
  }
  return override;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Paths where `actual` differs from `expected`. */
function diff(expected, actual, at) {
  if (isObject(expected) && isObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) => diff(expected[key], actual[key], `${at}.${key}`));
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length)
    return expected.flatMap((item, index) => diff(item, actual[index], `${at}[${index}]`));
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? []
    : [`${at}: expected ${JSON.stringify(expected)}, generated ${JSON.stringify(actual)}`];
}

/** JSON with comments and trailing commas (Wrangler's JSONC). */
function parseJsonc(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const pair = text.slice(index, index + 2);
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      output += text.slice(index, end + 1);
      index = end + 1;
    } else if (pair === '//') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
    } else if (pair === '/*') {
      index = text.indexOf('*/', index) + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1'));
}

function fail(message) {
  console.error(`environments: ${message}`);
  process.exit(1);
}
