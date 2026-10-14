/**
 * Settings → Rules' RPC (`RulesEditorRpc`): the approval rules' file opened at the latest landed
 * commit and saved through the one server-side commit flow, as the automation builder saves
 * (`pushSave`, `commit/file-save.ts`): a bean `rules-<short>` with the person as author,
 * landing through the pre-land check. Owners and maintainers save, with their
 * own identity, so the bean is the decision (`origin: decider`) and no card holds it; anyone
 * who can read the repository reads. The text is checked with the engine's own parser first.
 */
import { POLICY_PATH, POLICY_PATHS, readApprovalPolicy } from '@gitstalk/shared-race/policy-file';
import type { RepositoryForViewer } from '@gitstalk/shared-race/collaborators';
import type { SaveAccess } from '@gitstalk/shared-race/automation-editor';
import { RunId } from '@gitstalk/shared-race/ids';
import type { Viewer } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';
import type { RulesEditorRpc, RulesSource } from '@gitstalk/shared-race/rules-editor';
import { SaveRulesInput } from '@gitstalk/shared-race/rules-editor';

import { handleOf } from '../actions/actions-audit';
import type { Deps } from '../deps';
import type { Current, Engine } from '../automations/editor-rpc';
import {
  DECIDING,
  automationEditorRpc,
  currentFile,
  fileSaveOf,
  pushSave,
  staleOrEarlier,
} from '../automations/editor-rpc';
import { accessResult, viewerPrincipal } from '../repos/access';

type Opened = { readonly repo: RepositoryForViewer; readonly engine: Engine };

export function rulesEditorRpc(env: Env, deps: Deps): RulesEditorRpc {
  const open = async (
    viewer: Viewer,
    repoId: string,
    action: 'read' | 'write',
  ): Promise<RpcResult<Opened>> => {
    const allowed = await accessResult(deps.collaborators, await deps.registry.byId(repoId), {
      principal: viewerPrincipal(viewer),
      action,
      what: repoId,
    });
    if (!allowed.ok) return allowed;
    return {
      ok: true,
      value: { repo: allowed.value, engine: deps.run(RunId.parse(allowed.value.engine_id)) },
    };
  };
  const guarded = async <T>(work: () => Promise<RpcResult<T>>): Promise<RpcResult<T>> => {
    try {
      return await work();
    } catch (error: unknown) {
      deps.log.error('rules editor failed', { error });
      return failed({ code: 'internal', status: 500, message: 'internal error' });
    }
  };
  return {
    rulesSource: (viewer, repoId) =>
      guarded(async () => {
        const opened = await open(viewer, repoId, 'read');
        if (!opened.ok) return opened;
        const current = await currentRules(opened.value.engine);
        return ok<RulesSource>({
          ...current,
          role: opened.value.repo.viewer_role,
          save: rulesSaveAccess(opened.value.repo),
        });
      }),
    saveRules: (viewer, repoId, raw) =>
      guarded(async () => {
        const input = SaveRulesInput.safeParse(raw);
        if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid save');
        const opened = await open(viewer, repoId, 'write');
        if (!opened.ok) return opened;
        const { engine, repo } = opened.value;
        const access = rulesSaveAccess(repo);
        if (access.kind === 'refused')
          return failed({ code: 'forbidden', status: 403, message: access.reason });
        const current = await currentRules(engine);
        const read = readApprovalPolicy(input.data.content, current.path);
        if (read.kind === 'invalid') {
          const [first] = read.problems;
          const where = first?.line === null || first === undefined ? '' : `:${first.line}`;
          return invalid(`${current.path}${where}: ${first?.message ?? 'invalid'}`);
        }
        const { content } = input.data;
        const save = fileSaveOf(
          { kind: 'rules' },
          {
            handle: await handleOf(env, viewer),
            role: repo.viewer_role,
            base: current.base,
            path: current.path,
            content,
            message:
              input.data.message ??
              `${input.data.base.blob === null ? 'Add' : 'Edit'} approval rules (${current.path})`,
            idempotencyKey: input.data.idempotencyKey,
          },
        );
        if (current.base.blob !== input.data.base.blob)
          return staleOrEarlier(engine, save, () =>
            Promise.resolve({ base: current.base, content: current.content, author: null }),
          );
        if (content === current.content) return invalid('nothing changed');
        return pushSave(deps, engine, save);
      }),
    rulesBean: (viewer, repoId, bean) =>
      automationEditorRpc(env, deps).automationBean(viewer, repoId, bean),
  };
}

/** Owners and maintainers save; the rules decide what reaches a person, so writers do not. */
export function rulesSaveAccess(repo: RepositoryForViewer): SaveAccess {
  const role = repo.viewer_role;
  if (repo.archived_at !== null)
    return { kind: 'refused', reason: 'This repository is archived, so it is read-only.' };
  if (role === null || !DECIDING.has(role))
    return {
      kind: 'refused',
      reason: `Only maintainers and the owner change the approval rules; you have ${role === null ? 'no role' : `the ${role} role`}.`,
    };
  return { kind: 'allowed' };
}

/** The rules file on the latest landed commit: the first that exists, else the documented place. */
async function currentRules(engine: Engine): Promise<Current & { readonly path: string }> {
  const files = await Promise.all(POLICY_PATHS.map((path) => currentFile(engine, path)));
  const found = files.findIndex((file) => file.content !== null);
  const at = found === -1 ? 0 : found;
  const chosen = files[at];
  if (chosen === undefined) throw new Error('no policy paths');
  return { ...chosen, path: POLICY_PATHS[at] ?? POLICY_PATH };
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
