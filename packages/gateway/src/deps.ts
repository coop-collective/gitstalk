import type { ProductEventsDataset } from '@gitstalk/shared-identity/product-events';
import type { RunId } from '@gitstalk/shared-race/ids';

import { artifactsPort } from './adapters/artifacts';
import type { RunnerCapacity } from './capacity/runner-capacity';
import { RUNNER_POOL_NAME } from './capacity/runner-capacity';
import type { GatewayConfig } from './config';
import { readConfig, readSecrets } from './config';
import type { Logger } from './log';
import { createLogger } from './log';
import type { Registry } from './repos/registry';
import { d1Registry } from './repos/registry';
import type { CollaboratorStore } from './repos/collaborators';
import { d1Collaborators } from './repos/collaborators';
import type { RunDO } from './run/run-do';
import type { RunIndex } from './run/run-index';
import { RUN_INDEX_NAME } from './run/run-index';
import type { SpendGuards } from './run/spend-guards';
import { spendGuards } from './run/spend-guards';
import type { RunStreamDO } from './stream/run-stream-do';

/** What the routes use, built per request from the Worker's env (it depends on nothing else) (the composition root). */
export type Deps = {
  readonly config: GatewayConfig;
  readonly log: Logger;
  readonly adminToken: string;
  readonly tokenSecret: string;
  readonly run: (run: RunId) => DurableObjectStub<RunDO>;
  /** The kill switch and the repo sweep (forge D1, `run/spend-guards.ts`). */
  readonly guards: SpendGuards;
  /** The deprecated run index, read only by the one-time backfill (`run/run-index-backfill.ts`). */
  readonly runIndex: () => DurableObjectStub<RunIndex>;
  /** The run's streaming diffs (`stream_diffs`): posts, viewers' sockets, the stream RPC. */
  readonly streams: (run: RunId) => DurableObjectStub<RunStreamDO>;
  /** The runner pool races and repositories share: reservations, sandbox leases, counts. */
  readonly runnerPool: () => DurableObjectStub<RunnerCapacity>;
  readonly now: () => number;
  /** The repository registry (`repos/registry.ts`): names, owners, visibility, engines. */
  readonly registry: Registry;
  /** The forge database itself, for indexes no store wraps (the automations list). */
  readonly forge: D1Database;
  /** Collaborators, invitations and sessions (`repos/collaborators.ts`), beside the registry. */
  readonly collaborators: CollaboratorStore;
  /** Product analytics (Analytics Engine `product_events`): beans pushed by people. */
  readonly productEvents: ProductEventsDataset;
};

export function createDeps(env: Env): Deps {
  const config = readConfig(env);
  const { adminToken, tokenSecret } = readSecrets(env);
  const log = createLogger(config.logLevel, { component: 'gateway' });
  return {
    config,
    log,
    adminToken,
    tokenSecret,
    run: (run) => env.RUNS.getByName(run),
    guards: createSpendGuards(env, log),
    runIndex: () => env.RUN_INDEX.getByName(RUN_INDEX_NAME),
    streams: (run) => env.RUN_STREAMS.getByName(run),
    runnerPool: () => env.RUNNER_CAPACITY.getByName(RUNNER_POOL_NAME),
    now: () => Date.now(),
    registry: d1Registry(env.FORGE, env),
    forge: env.FORGE,
    collaborators: d1Collaborators(env.FORGE, () => Date.now(), env),
    productEvents: env.PRODUCT_EVENTS,
  };
}

/** The spend guards over this Worker's bindings (the routes' and the cron's). */
export function createSpendGuards(env: Env, log: Logger): SpendGuards {
  return spendGuards({
    db: env.FORGE,
    run: (run) => env.RUNS.getByName(run),
    raceRepos: artifactsPort(env.ARTIFACTS),
    now: () => Date.now(),
    log,
  });
}
