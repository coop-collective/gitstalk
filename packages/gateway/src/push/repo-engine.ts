/**
 * A repository's continuous engine: which Artifacts repo it drives, whose it is, and its id.
 * The id is derived from `<owner>/<repo>`, so the git proxy finds the engine of
 * `/git/<owner>/<repo>.git` without a lookup, and opening the same repository twice returns
 * the same engine.
 */
import { z } from 'zod';

import { RunId } from '@gitstalk/shared-race/ids';
import { RunSuite } from '@gitstalk/shared-race/suite';

const Handle = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/);

/**
 * Engine settings an operator may set on a continuous engine over its defaults
 * (`CONTINUOUS_SETTINGS`), for load tests and paired comparisons: the concurrency of its checks
 * (`preland_sandboxes`: pre-land checks at once, one sandbox per bean, default 32; `ci_slots`:
 * validations at once, default 2) and the evidence-promotion track. Everything else stays the
 * continuous engine's.
 */
export const RepoEngineOverrides = z.strictObject({
  preland_sandboxes: z.number().int().min(1).max(64).optional(),
  ci_slots: z.number().int().min(1).max(16).optional(),
  read_maps: z.enum(['off', 'preland', 'all']).optional(),
  evidence_promotion: z.boolean().optional(),
  evidence_read_sets: z.enum(['complete', 'static']).optional(),
  affected_validation: z.boolean().optional(),
  audit_every: z.number().int().min(0).max(100).optional(),
  /** `suite`: run the engine's suite and ignore `.gitstalk/checks.yml` (the default reads it). */
  checks_source: z.enum(['suite', 'repository']).optional(),
  /** Approval rules from `.gitstalk/policy.yml` on the stalk; absent: on with repository checks. */
  approval_rules: z.boolean().optional(),
});
export type RepoEngineOverrides = z.infer<typeof RepoEngineOverrides>;

/** `openRepoEngine`'s input: the repository-creation side's contract. */
export const OpenRepoEngineInput = z.strictObject({
  repoName: Handle,
  /** The Artifacts repo (in the gateway's namespace) the repository's git lives in. */
  artifactsRepo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  owner: z.strictObject({ id: z.string().min(1).max(100), handle: Handle }),
  settings: z
    .strictObject({
      /**
       * An operator's suite for every check, instead of the repository's `.gitstalk/checks.yml`
       * (`checks_source: suite`; load tests and paired comparisons).
       */
      suite: RunSuite.optional(),
      /** The branch the sprout and the stalk start from when the repo has neither (default `main`). */
      base_branch: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
        .optional(),
      /** A bean's web page; `{bean}` is replaced by its name. */
      bean_url: z.url().max(500).optional(),
      /** Engine settings over the continuous defaults (`RepoEngineOverrides`). */
      engine: RepoEngineOverrides.optional(),
    })
    .optional(),
});
export type OpenRepoEngineInput = z.infer<typeof OpenRepoEngineInput>;

/** What a continuous engine's Durable Object keeps about its repository. */
export const RepoEngineRecord = z.object({
  engineId: RunId,
  owner: z.object({ id: z.string(), handle: z.string() }),
  repoName: z.string(),
  artifactsRepo: z.string(),
  beanUrl: z.string().nullable(),
});
export type RepoEngineRecord = z.infer<typeof RepoEngineRecord>;

/** The engine id of `<owner>/<repo>` (case-insensitive): `r` and 19 hex digits of a SHA-256. */
export async function repoEngineId(owner: string, repo: string): Promise<RunId> {
  return engineIdOf(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
}

/**
 * The engine id of a registry repository, from its Artifacts repo (named by the repository's
 * id), not its address: a repository renamed or transferred away leaves its address free for
 * a new repository, whose engine must not be the old one's. `#` cannot appear in a handle, so
 * these ids never meet an address-derived one. Repositories created before this keep the id
 * their record holds.
 */
export async function registryEngineId(artifactsRepo: string): Promise<RunId> {
  return engineIdOf(`#registry/${artifactsRepo}`);
}

/**
 * The engine a repository created empty gets when its first push becomes its stalk (§10 of
 * the repositories doc): a new engine starts from that commit, and the one that held the seed
 * is closed.
 */
export async function firstPushEngineId(artifactsRepo: string): Promise<RunId> {
  return engineIdOf(`#registry/${artifactsRepo}#first-push`);
}

async function engineIdOf(key: string): Promise<RunId> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return RunId.parse(`r${hex.slice(0, 19)}`);
}

/** A bean's web link from the engine's template, if it has one. */
export function beanLink(record: RepoEngineRecord, bean: string): string | null {
  return record.beanUrl === null
    ? null
    : record.beanUrl.replaceAll('{bean}', encodeURIComponent(bean));
}
