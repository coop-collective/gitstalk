/**
 * The automation builder's RPC (`AutomationEditorRpc`, doc 25 §7.13). A save is a bean, never a
 * push to a line: the engine commits the file's new text through the one server-side commit
 * flow `bean_commit` uses (`commit/server-commit.ts`, by way of `commit/file-save.ts`), as
 * `bean/automation-<slug>-<short>` with the person's identity, and submits it as any push, so
 * it lands only through the pre-land check. When the file changed on the latest landed commit
 * since the editor opened it, the save is refused as `stale` with that version, for the editor
 * to merge, unless an earlier try of the same save (its idempotency key) made the bean that
 * changed it. Access: read to open, write to save (maintain when the checks file protects it),
 * maintain to start a test run.
 */
import type {
  AutomationBase,
  AutomationBeanStatus,
  AutomationEditorRpc,
  AutomationSource,
  AutomationTheirs,
  SaveAccess,
  SaveAutomationResult,
} from '@gitstalk/shared-race/automation-editor';
import {
  AutomationPath,
  SaveAutomationInput,
  TestAutomationInput,
} from '@gitstalk/shared-race/automation-editor';
import { readAutomationFile } from '@gitstalk/shared-race/automation-file';
import {
  CHECKS_PATHS,
  matchesPattern,
  protectedPatterns,
  resolveChecksFile,
} from '@gitstalk/shared-race/checks-config';
import { readFirstPresent } from '@gitstalk/shared-race/config-dir';
import type { RepositoryForViewer, ViewerRole } from '@gitstalk/shared-race/collaborators';
import { RunId, Sha, TaskId } from '@gitstalk/shared-race/ids';
import type { Viewer } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';

import { handleOf } from '../actions/actions-audit';
import { readActionsConfig } from '../actions/actions-config';
import { compileAutomation } from '../actions/automation-job';
import type { ProtectedAccess } from '../checks/protected-access';
import type { FileSave, SaveEditor } from '../commit/file-save';
import type { Deps } from '../deps';
import { accessResult, viewerPrincipal } from '../repos/access';
import type { RunDO } from '../run/run-do';

export type Engine = DurableObjectStub<RunDO>;
type Opened = { readonly repo: RepositoryForViewer; readonly engine: Engine };

/** The line a save starts from and lands on: the latest landed commit. */
const LANDED = 'sprout';
export const DECIDING: ReadonlySet<ViewerRole> = new Set(['owner', 'maintain']);
/** The runner's commit names: today's, and the one from before the rename in older history. */
const RUNNER_NAMES: ReadonlySet<string> = new Set(['gitstalk-runner', 'gitstalk-runner']);

export function automationEditorRpc(env: Env, deps: Deps): AutomationEditorRpc {
  const open = async (
    viewer: Viewer,
    repoId: string,
    action: 'read' | 'write' | 'actions',
  ): Promise<RpcResult<Opened>> => {
    const allowed = await accessResult(deps.collaborators, await deps.registry.byId(repoId), {
      principal: viewerPrincipal(viewer),
      action,
      what: repoId,
    });
    if (!allowed.ok) return allowed;
    const engine = deps.run(RunId.parse(allowed.value.engine_id));
    return { ok: true, value: { repo: allowed.value, engine } };
  };
  const guarded = async <T>(work: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> => {
    try {
      return await work();
    } catch (error: unknown) {
      deps.log.error('automation editor failed', { error });
      return failed({ code: 'internal', status: 500, message: 'internal error' });
    }
  };
  const limits = { maxTimeoutMinutes: readActionsConfig(env).jobTimeoutMinutes };

  return {
    automationSource: (viewer, repoId, path) =>
      guarded(async () => {
        const parsedPath = AutomationPath.safeParse(path);
        if (!parsedPath.success) return invalid(parsedPath.error.issues[0]?.message ?? 'bad path');
        const opened = await open(viewer, repoId, 'read');
        if (!opened.ok) return opened;
        const [current, protection] = await Promise.all([
          currentFile(opened.value.engine, parsedPath.data),
          protectionOf(opened.value.engine, parsedPath.data),
        ]);
        const role = opened.value.repo.viewer_role;
        return ok<AutomationSource>({
          path: parsedPath.data,
          base: current.base,
          content: current.content,
          role,
          save: saveAccess(opened.value.repo, protection),
          canTestRun: role !== null && DECIDING.has(role) && opened.value.repo.archived_at === null,
          protectedBy: protection,
          maxTimeoutMinutes: limits.maxTimeoutMinutes,
        });
      }),
    saveAutomation: (viewer, repoId, raw) =>
      guarded(async () => {
        const input = SaveAutomationInput.safeParse(raw);
        if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid save');
        const opened = await open(viewer, repoId, 'write');
        if (!opened.ok) return opened;
        const { engine, repo } = opened.value;
        const { path, content } = input.data;
        const protection = await protectionOf(engine, path);
        const access = saveAccess(repo, protection);
        if (access.kind === 'refused')
          return failed({ code: 'forbidden', status: 403, message: access.reason });
        if (content !== null) {
          const file = readAutomationFile(path, content, limits);
          const [first] = file.problems;
          if (first !== undefined)
            return invalid(
              `${path}${first.line === null ? '' : `:${first.line}`}: ${first.message}`,
            );
        }
        const current = await currentFile(engine, path);
        const save = fileSaveOf(
          { kind: 'automation' },
          {
            handle: await handleOf(env, viewer),
            role: repo.viewer_role,
            base: current.base,
            path,
            content,
            message: input.data.message ?? defaultMessage(path, content, input.data.base),
            idempotencyKey: input.data.idempotencyKey,
          },
        );
        if (current.base.blob !== input.data.base.blob)
          return staleOrEarlier(engine, save, () => theirsOf(engine, path, current));
        if (content === null && current.base.blob === null)
          return invalid(`${path} does not exist on the latest landed commit`);
        if (content !== null && content === current.content) return invalid('nothing changed');
        return pushSave(deps, engine, save);
      }),
    automationBean: (viewer, repoId, bean) =>
      guarded(async () => {
        const name = TaskId.safeParse(bean);
        if (!name.success) return invalid(`"${bean}" is not a bean name`);
        const opened = await open(viewer, repoId, 'read');
        if (!opened.ok) return opened;
        const { pushed } = await opened.value.engine.agentBean(name.data);
        if (pushed === null) return failed(notFound(`bean ${bean}`));
        return ok<AutomationBeanStatus>({
          bean: pushed.bean,
          phase: pushed.phase,
          reason: pushed.reason,
          landedSha: pushed.landedSha,
          details: [
            ...(pushed.rework?.failing ?? []).map((test) => `failing: ${test}`),
            ...(pushed.rework?.conflicts ?? []).map((file) => `conflict: ${file}`),
            ...(pushed.verdict?.lines ?? []),
          ].slice(0, 20),
        });
      }),
    testAutomation: (viewer, repoId, raw) =>
      guarded(async () => {
        const input = TestAutomationInput.safeParse(raw);
        if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid draft');
        const opened = await open(viewer, repoId, 'actions');
        if (!opened.ok) return opened;
        const file = readAutomationFile(input.data.path, input.data.content, limits);
        const [first] = file.problems;
        if (first !== undefined || file.info === null)
          return invalid(`the draft is not valid: ${first?.message ?? 'no automation'}`);
        const stalk = await opened.value.engine.repoTree('stalk', '', false);
        if (!stalk.ok) return failed(stalk.error);
        const started = await env.ACTIONS_REPOS.getByName(repoId).testAutomation({
          repoId,
          path: input.data.path,
          // A test never writes the automation's memory: the compiled job has no save step.
          source: compileAutomation({ name: file.name, info: { ...file.info, memoryRef: null } }),
          sha: stalk.value.commit,
          actor: await handleOf(env, viewer),
          automation: { model: file.info.model, maxCostUsd: file.info.maxCostUsd },
        });
        return started.ok ? ok({ runId: started.value.id }) : started;
      }),
  };
}

/** Who may save: write to push a bean, maintain when the file is a protected path. */
export function saveAccess(repo: RepositoryForViewer, protectedBy: string | null): SaveAccess {
  const role = repo.viewer_role;
  if (repo.archived_at !== null)
    return { kind: 'refused', reason: 'This repository is archived, so it is read-only.' };
  if (role === null || role === 'read')
    return {
      kind: 'refused',
      reason: `Saving pushes a bean, which needs the write role; you have ${role === null ? 'no role' : 'the read role'}.`,
    };
  if (protectedBy !== null && !DECIDING.has(role))
    return {
      kind: 'refused',
      reason: `The checks file protects this file (${protectedBy}), so only maintainers and the owner may change it; you have the ${role} role.`,
    };
  return { kind: 'allowed' };
}

/** A save is the person's own change, made in the web editor they signed in to. */
export function protectedAccessOf(handle: string, role: ViewerRole | null): ProtectedAccess {
  return {
    allowed: role !== null && DECIDING.has(role),
    who: `@${handle} (${role ?? 'no role'}, with the web editor)`,
  };
}

export type Current = { readonly base: AutomationBase; readonly content: string | null };

/** The file on the latest landed commit: that commit, its blob there and its text. */
export async function currentFile(engine: Engine, path: string): Promise<Current> {
  const directory = path.slice(0, path.lastIndexOf('/'));
  const listed = await engine.repoTree(LANDED, directory, false);
  if (!listed.ok) {
    if (listed.error.status !== 404) throw new Error(listed.error.message);
    const root = await engine.repoTree(LANDED, '', false);
    if (!root.ok) throw new Error(root.error.message);
    return { base: { commit: root.value.commit, blob: null }, content: null };
  }
  const entry = listed.value.entries.find((candidate) => candidate.path === path);
  const commit = listed.value.commit;
  if (entry === undefined) return { base: { commit, blob: null }, content: null };
  const file = await engine.repoFile(commit, path);
  if (!file.ok) throw new Error(file.error.message);
  return { base: { commit, blob: entry.sha }, content: file.value.content };
}

/** The newer version, with the author of the newest commit that changed the file. */
async function theirsOf(engine: Engine, path: string, current: Current): Promise<AutomationTheirs> {
  const log = await engine.repoLog(current.base.commit, [path], 1);
  const commit = log.ok ? log.value.commits[0] : undefined;
  if (commit === undefined) return { base: current.base, content: current.content, author: null };
  return { base: current.base, content: current.content, author: await pusherOf(engine, commit) };
}

/**
 * Who changed it: a landed commit is the runner's squash, so the person is the pusher of the
 * bean its `Task:` trailer names; any other commit names its own author.
 */
async function pusherOf(
  engine: Engine,
  commit: { readonly message: string; readonly author: { readonly name: string } },
): Promise<string | null> {
  const task = /^Task: (\S+)$/m.exec(commit.message)?.[1];
  const bean = task === undefined ? null : TaskId.safeParse(task);
  if (bean?.success === true) {
    const { pushed } = await engine.agentBean(bean.data);
    if (pushed !== null) return pushed.actor;
  }
  return RUNNER_NAMES.has(commit.author.name) ? null : commit.author.name;
}

/** `protected_paths` of the latest landed checks file (`.gitstalk/` or `.beanstalk/`) that cover `path`. */
async function protectionOf(engine: Engine, path: string): Promise<string | null> {
  const checks = await readFirstPresent(CHECKS_PATHS, async (candidate) => {
    const file = await engine.repoFile(LANDED, candidate);
    return file.ok ? file.value.content : null;
  });
  const patterns = protectedPatterns(resolveChecksFile(checks));
  return patterns.find((pattern) => matchesPattern(path, pattern)) ?? null;
}

/** A save from an editor: the person, the file's new text on `base`, and the attempt's key. */
export function fileSaveOf(
  editor: SaveEditor,
  save: {
    readonly handle: string;
    readonly role: ViewerRole | null;
    readonly base: AutomationBase;
    readonly path: string;
    readonly content: string | null;
    readonly message: string;
    /** The web's key for this attempt; a request without one is its own attempt. */
    readonly idempotencyKey: string | undefined;
  },
): FileSave {
  return {
    editor,
    actor: save.handle,
    protectedAccess: protectedAccessOf(save.handle, save.role),
    base: Sha.parse(save.base.commit),
    path: save.path,
    content: save.content,
    message: save.message,
    idempotencyKey: save.idempotencyKey ?? crypto.randomUUID(),
  };
}

/**
 * Saves one file as a bean: the engine commits it through the server-side commit flow
 * (validation, caps, idempotency, a new bean's compare-and-swap) and submits it.
 */
export async function pushSave(
  deps: Deps,
  engine: Engine,
  save: FileSave,
): Promise<RpcResult<SaveAutomationResult>> {
  const committed = await engine.repoSaveFile(save);
  if (!committed.ok) return committed;
  const result = committed.value;
  if (result.kind === 'conflict')
    return failed({
      code: 'conflict',
      status: 409,
      message: `${result.branch} exists already; save again to push a new bean`,
    });
  deps.log.info('file saved as a bean', { bean: result.bean, path: save.path });
  return ok<SaveAutomationResult>({ kind: 'pushed', bean: result.bean, commit: result.commit });
}

/**
 * The file changed since the editor opened it: an earlier try of this very save (a retry after
 * its bean landed) answers with that bean; anything else is `stale`, with the newer version.
 */
export async function staleOrEarlier(
  engine: Engine,
  save: FileSave,
  theirs: () => Promise<AutomationTheirs>,
): Promise<RpcResult<SaveAutomationResult>> {
  const earlier = await engine.repoEarlierSave(save);
  if (earlier !== null)
    return ok<SaveAutomationResult>({ kind: 'pushed', bean: earlier.bean, commit: earlier.commit });
  return ok<SaveAutomationResult>({ kind: 'stale', theirs: await theirs() });
}

/** Named from the version the editor opened, so a retry of the save is the same save. */
function defaultMessage(path: string, content: string | null, opened: AutomationBase): string {
  const file = path.split('/').at(-1) ?? path;
  if (content === null) return `Delete automation ${file}`;
  return opened.blob === null ? `Add automation ${file}` : `Edit automation ${file}`;
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function failed<T>(error: RpcError): RpcResult<T> {
  return { ok: false, error };
}

function invalid<T>(message: string): RpcResult<T> {
  return failed({ code: 'invalid_request', status: 400, message });
}

function notFound(what: string): RpcError {
  return { code: 'not_found', status: 404, message: `no ${what}` };
}
