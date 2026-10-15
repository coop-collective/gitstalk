/**
 * What the registry RPC and the creation path (`repository-creation.ts`) work with, built from
 * the Worker's bindings: the RPC entrypoint, the git proxy's push-to-create and git over SSH
 * all create repositories through the same deps.
 */
import type { IdentityEnv } from '@gitstalk/shared-identity/identity-env';

import type { RepositoryStorage } from '../adapters/repository-storage';
import { repositoryStorage } from '../adapters/repository-storage';
import { readConfig } from '../config';
import { createDeps } from '../deps';
import type { Logger } from '../log';
import { createLogger } from '../log';
import type { CollaboratorStore } from './collaborators';
import { d1Collaborators } from './collaborators';
import type { CreationLog } from './creation-log';
import { d1CreationLog } from './creation-log';
import type { RepoEnginePort } from './engine-port';
import { repoEnginePort } from './engine-port';
import type { Registry } from './registry';
import { d1Registry } from './registry';
import type { RepositoryCleanup } from './repository-cleanup';
import { cleanupPortsFrom, repositoryCleanup } from './repository-cleanup';

export type RepositoriesDeps = {
  readonly registry: Registry;
  readonly collaborators: CollaboratorStore;
  /** People and orgs (IDENTITY_DB): whose namespace a handle is, and org roles. */
  readonly identity: IdentityEnv;
  readonly storage: RepositoryStorage;
  readonly engine: RepoEnginePort;
  /** What a deleted repository leaves outside the registry; never throws. */
  readonly cleanup: RepositoryCleanup;
  /** Who created which repository and when: the creation rate limit counts it. */
  readonly creations: CreationLog;
  readonly log: Logger;
  readonly now: () => number;
  readonly newId: () => string;
  /** This deployment's web origin: a template's files link to its docs there. */
  readonly webUrl: string;
};

const ID_LENGTH = 12;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The deps on the gateway's bindings. */
export function repositoriesDepsFrom(env: Env): RepositoriesDeps {
  const config = readConfig(env);
  const cleanupLog = createLogger(config.logLevel, { component: 'repository-cleanup' });
  return {
    registry: d1Registry(env.FORGE, env),
    collaborators: d1Collaborators(env.FORGE, () => Date.now(), env),
    identity: env,
    storage: repositoryStorage(env.REPOS),
    engine: repoEnginePort(createDeps(env)),
    cleanup: repositoryCleanup(cleanupPortsFrom(env, cleanupLog)),
    creations: d1CreationLog(env.FORGE),
    log: createLogger(config.logLevel, { component: 'repositories' }),
    now: () => Date.now(),
    newId: newRepositoryId,
    webUrl: config.webUrl,
  };
}

/** A fresh repository id: 12 of [a-z0-9], which is also a valid run id for the engine. */
export function newRepositoryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}
