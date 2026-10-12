/**
 * Agents working on a person's repository through MCP (`docs/claude-opus/23-mcp-repository-tools.md`):
 * the gateway RPC the MCP Worker calls for its repository tools. Git stays the interface;
 * these calls add what git cannot say: which repositories a person may use, a reserved bean
 * name with its intent, a bean's verdict with the beans it collided with, and a shared
 * backlog whose tasks two agents cannot both claim.
 *
 * Like the rest of the binding, the gateway trusts its caller (the MCP Worker) for who the
 * person is and which scopes their session holds; it decides access itself, with the same
 * rule git uses (`mayUseEngine`).
 */
import { z } from 'zod';

import type { AgentPrincipal, ViewerRole } from './collaborators';
import type { PushedBeanStatus, RpcResult } from './rpc';

/** Who is asking: the person behind an MCP session, its scopes and client (collaborators' type). */
export type { AgentPrincipal } from './collaborators';

/** The scopes of an agent session (`@gitstalk/shared-identity/scopes`). */
export type SessionScope = 'read' | 'collaborate' | 'write' | 'secrets';

/** `owner/name`, as in `/<owner>/<repo>` and the clone URL. */
export const RepoSlug = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'owner/name');

/** A bean name: the branch is `bean/<name>`. */
export const BeanName = z
  .string()
  .trim()
  .transform((name) => name.replace(/^(?:refs\/heads\/)?beans?\//, ''))
  .pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, 'letters, digits, ".", "_" and "-"; up to 32')
      .refine((name) => !name.endsWith('.lock') && !name.includes('..'), 'not usable in a ref'),
  );

/** A task id in a backlog: what `Task: <id>` trailers and `-o task=<id>` name. */
export const BacklogTaskId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._#/-]{0,63}$/, 'a task id from task_list');

export const BeanOpenInput = z.object({
  bean: BeanName,
  intent: z.string().trim().min(1).max(4000),
  task: BacklogTaskId.optional(),
});
export type BeanOpenInput = z.input<typeof BeanOpenInput>;

/** A repository an agent may work on. */
export type AgentRepository = {
  /** `owner/name`. */
  readonly repo: string;
  readonly description: string;
  readonly visibility: 'public' | 'private' | 'internal';
  /** The person's role: owner, maintain, write, read, or null (a public repository). */
  readonly role: ViewerRole | null;
  /** What the session may do here: push beans (`write`: the write role and scope) or only read. */
  readonly access: 'write' | 'read';
  /** The engine id the run read tools take. */
  readonly engine_id: string;
  /** `/git/<owner>/<name>.git` on the gateway. */
  readonly git_path: string;
};

/** A bean name reserved by `bean_open` until its first push (or until it expires). */
export type BeanReservation = {
  readonly bean: string;
  readonly actor: string;
  readonly intent: string;
  readonly task: string | null;
  /** ISO 8601. */
  readonly reserved_at: string;
  readonly expires_at: string;
};

export type BeanOpened = {
  readonly repo: string;
  readonly bean: string;
  readonly branch: string;
  readonly intent: string;
  readonly task: string | null;
  /** The sprout's head: start the branch from it (`git fetch origin sprout`). */
  readonly sprout: string | null;
  readonly expires_at: string;
};

/** A landed bean a red collided with: what it meant and what it changed. */
export type CollidedBean = {
  readonly bean: string;
  readonly title: string;
  readonly intent: string;
  readonly landed_sha: string | null;
  /** What it changed (`git diff --stat` of its branch); counts are null when unknown. */
  readonly files: readonly {
    readonly path: string;
    readonly additions: number | null;
    readonly deletions: number | null;
  }[];
};

/** Everything about one bean an agent needs after a push (`bean_status`, `bean_wait`). */
export type AgentBean = {
  readonly repo: string;
  /** `open`: reserved, not pushed yet. Otherwise the pushed bean's phase. */
  readonly phase: 'open' | PushedBeanStatus['phase'];
  readonly reservation: BeanReservation | null;
  readonly pushed: (PushedBeanStatus & { readonly intent: string }) | null;
  /** The engine's facts behind a red or a conflict, for the current push. */
  readonly rework: {
    readonly failing_tests: readonly string[];
    readonly conflicts: readonly string[];
    readonly collided_with: readonly CollidedBean[];
  } | null;
  /** The lines the pushes printed, oldest first (the last 30). */
  readonly journey: readonly { readonly push: number; readonly text: string }[];
};

/** What `bean_wait` waits for: the pre-land verdict, or the stalk (validated, or sent back). */
export const BeanWaitUntil = z.enum(['verdict', 'stalk']);
export type BeanWaitUntil = z.infer<typeof BeanWaitUntil>;

/** Longest a `bean_wait` holds, as `git push -o wait=<seconds>` allows. */
export const MAX_BEAN_WAIT_SECONDS = 1800;

export type BeanWaited = AgentBean & {
  readonly waited_s: number;
  /** True when the wait ended on its timeout, not on the bean. */
  readonly timed_out: boolean;
};

export type BacklogTaskState = 'open' | 'claimed' | 'in_progress' | 'done';

export type BacklogTask = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly state: BacklogTaskState;
  /** Who holds it (a claim or a bean for it), or null. */
  readonly by: string | null;
  /** The bean working on it or that finished it. */
  readonly bean: string | null;
  /** When a claim lapses (ISO 8601), or null. */
  readonly until: string | null;
};

export type Backlog = {
  readonly repo: string;
  /** The file it was read from on the sprout, or null when the repository has none. */
  readonly file: string | null;
  readonly tasks: readonly BacklogTask[];
};

export type TaskClaimed = { readonly repo: string; readonly task: BacklogTask };

/** A repository's automations and their recent runs, for `automation_list` (doc 25 §7). */
export type AgentAutomations = {
  readonly repo: string;
  readonly automations: readonly {
    readonly path: string;
    readonly name: string;
    readonly state: 'active' | 'invalid';
    readonly problems: readonly string[];
    readonly triggers: readonly string[];
    readonly harness: 'agent' | 'shell' | null;
    readonly model: string | null;
    readonly acts_as: string | null;
    readonly memory_ref: string | null;
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly automation: string;
    readonly number: number;
    readonly event: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly created_at: string;
  }[];
};

/** The gateway RPC behind the MCP repository tools. */
export type AgentReposRpc = {
  /** The repositories the person owns or collaborates on (public ones are named directly). */
  agentRepositories(principal: AgentPrincipal): Promise<RpcResult<readonly AgentRepository[]>>;
  /** One repository by `owner/name`, when the person may use it; 404 otherwise. */
  agentRepository(principal: AgentPrincipal, repo: string): Promise<RpcResult<AgentRepository>>;
  /** The beans pushed to it, newest activity first (in flight first). */
  agentPushedBeans(
    principal: AgentPrincipal,
    repo: string,
  ): Promise<RpcResult<readonly PushedBeanStatus[]>>;
  agentBean(principal: AgentPrincipal, repo: string, bean: string): Promise<RpcResult<AgentBean>>;
  /** Holds until the bean's current check ends (or the stalk, or `seconds`), then describes it. */
  agentWaitBean(
    principal: AgentPrincipal,
    repo: string,
    bean: string,
    wait: { readonly until: BeanWaitUntil; readonly seconds: number },
  ): Promise<RpcResult<BeanWaited>>;
  /** Reserves a bean name with its intent (and claims its task); needs `write`. */
  agentOpenBean(
    principal: AgentPrincipal,
    repo: string,
    input: BeanOpenInput,
  ): Promise<RpcResult<BeanOpened>>;
  agentBacklog(principal: AgentPrincipal, repo: string): Promise<RpcResult<Backlog>>;
  /** Claims a backlog task for the person; needs the write role and scope. */
  agentClaimTask(
    principal: AgentPrincipal,
    repo: string,
    task: string,
  ): Promise<RpcResult<TaskClaimed>>;
  /** Gives a task back (the person's claim and names reserved for it); as a claim needs. */
  agentReleaseTask(
    principal: AgentPrincipal,
    repo: string,
    task: string,
  ): Promise<RpcResult<TaskClaimed>>;
  /** The automations the stalk's files define, and their 20 newest runs (read). */
  agentAutomations?(principal: AgentPrincipal, repo: string): Promise<RpcResult<AgentAutomations>>;
};
