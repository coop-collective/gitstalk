/**
 * What every tool reads with: the run the caller's token names, the forge over the gateway,
 * and the run's reduced event log, loaded at most once per MCP request.
 */
import type { RunId, TaskId } from '@gitstalk/shared-race/ids';
import type { GatewayRpc } from '@gitstalk/shared-race/rpc';
import { TaskId as TaskIdSchema } from '@gitstalk/shared-race/ids';

import type { Classifier } from '@gitstalk/shared-ask/ask/classifier';
import type { Picker } from '@gitstalk/shared-ask/pick/picker';
import { allEvents } from '@gitstalk/shared-ask/ask/plan-context';
import type { BeanStreamSummary } from '@gitstalk/shared-ask/forge/bean-stream';
import { currentStreams } from '@gitstalk/shared-ask/forge/bean-stream';
import type { ForgeSource } from '@gitstalk/shared-ask/forge/forge-source';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { RaceState } from '@gitstalk/shared-ask/race/race-state';
import { reduceRace } from '@gitstalk/shared-ask/race/reduce-race';

import type { Scope } from '@gitstalk/shared-identity/scopes';
import type { AgentActionsRpc } from '@gitstalk/shared-race/agent-actions';
import type { AgentPrincipal, AgentReposRpc } from '@gitstalk/shared-race/agent-repos';

import type { ContributorSession } from '../auth/bearer';
import type { Logger } from '../log';

/** A person's agent session (OAuth grant or personal token), for the session tools. */
export type AgentSessionContext = {
  /** The person's account id, for repository access (`repository-access.ts`). */
  readonly userId: string;
  readonly handle: string;
  readonly clientName: string;
  /**
   * The agent session as the approval rules' self-approval check compares it with a bean's
   * pusher: `oauth:<client id>` for an OAuth grant, `token` for a personal token as the bearer.
   */
  readonly agentKey: string;
  readonly via: 'oauth' | 'token';
  readonly scopes: readonly Scope[];
  /** The person and scopes, as the gateway's repository RPC takes them. */
  readonly principal: AgentPrincipal;
  /**
   * Mints a short-lived git credential for one repository (its engine id), no wider than the
   * session and than the person's access there; null when the session has no git scope. With
   * `access: 'create'`, `binding` is `new:owner/name`, an address with no repository yet: the
   * credential (read, write and create) may create it with a push. Null without those scopes.
   */
  mintGitToken(repository: {
    readonly binding: string;
    readonly access: 'read' | 'write' | 'create';
    readonly ttlSeconds: number;
  }): Promise<MintedGitToken | null>;
};

/**
 * What a server's tools read with: the caller's own run (run tokens always have one; agent
 * sessions the demo or newest run, if any) and, for sessions, any repository the person may
 * use, named per call as `owner/name`.
 */
export type ToolScope = {
  readonly own: ToolContext | null;
  /** The context a call reads: its `repo`, or the caller's own run. */
  context(repo: string | undefined): Promise<ToolContext>;
  readonly session?: AgentSessionContext;
  /** The gateway's repository RPC (sessions only). */
  readonly agents?: AgentReposRpc;
  /** The gateway's Actions RPC (sessions only). */
  readonly actions?: AgentActionsRpc;
  /** The gateway binding, for `whoami` with a repository (`repository-access.ts`). */
  readonly gateway: object;
  /** The gateway's public origin, for clone URLs and credentials. */
  readonly gitOrigin: string;
  readonly webUrl: string;
};

export type MintedGitToken = {
  readonly token: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: string;
};

export type RunSnapshot = {
  readonly events: readonly RaceEvent[];
  readonly state: RaceState;
};

export type ToolContext = {
  readonly run: RunId;
  /** The gateway's RPC, for what the forge adapter does not carry (the run view's window). */
  readonly gateway: GatewayRpc;
  readonly source: ForgeSource;
  readonly classifier: Classifier;
  /** Orders what an answer shows, as the web app does (`docs/claude-opus/14` §5). */
  readonly picker: Picker;
  /** The web app's origin, for `preview_url`. */
  readonly webUrl: string;
  readonly contributor?: ContributorSession;
  /** Set for OAuth sessions and personal tokens: who the person is. */
  readonly session?: AgentSessionContext;
  readonly log?: Logger;
  snapshot(): Promise<RunSnapshot>;
};

/** A tool context whose snapshot is read once, on first use. */
export function toolContext(input: Omit<ToolContext, 'snapshot'>): ToolContext {
  let loaded: Promise<RunSnapshot> | undefined;
  return {
    ...input,
    snapshot: () => {
      loaded ??= loadSnapshot(input.source, input.run);
      return loaded;
    },
  };
}

async function loadSnapshot(source: ForgeSource, run: RunId): Promise<RunSnapshot> {
  const [events, options] = await Promise.all([allEvents(source, run), source.runOptions(run)]);
  return { events, state: reduceRace(events, options) };
}

/**
 * The beans whose agents are writing now (`stream_diffs`), by task: the files they are
 * editing before any commit exists. None when the run does not stream, or the gateway
 * predates it or fails: this is a hint, never a reason to fail a tool.
 */
export async function editingNow(
  ctx: ToolContext,
): Promise<ReadonlyMap<string, BeanStreamSummary>> {
  try {
    const streams = await currentStreams(ctx.gateway, ctx.run);
    return new Map(streams.map((stream) => [stream.task, stream]));
  } catch {
    // An older gateway or a failed read: answer from the event log alone.
    return new Map();
  }
}

/** A bean id from `t032`, `beans/t032` or `bean/<name>`; undefined when it is none. */
export function parseBean(value: string): TaskId | undefined {
  const parsed = TaskIdSchema.safeParse(value.trim().replace(/^beans?\//, ''));
  return parsed.success ? parsed.data : undefined;
}

/** The bean's branch, the handle agents and git use. */
export function branchOf(bean: TaskId): string {
  return `beans/${bean}`;
}

/** Text cut to `max` characters, marked when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Whole seconds, for race clocks in answers. */
export function seconds(t: number | null): number | null {
  return t === null ? null : Math.round(t);
}
