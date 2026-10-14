/**
 * Settings → Checks' RPC (`ChecksEditorRpc`): "Convert to YAML" for a repository whose checks
 * are still in a `checks.toml`. The file on the latest landed commit is converted with the
 * engine's own converter (`tomlChecksToYaml`) and saved through the one server-side commit flow,
 * as the rules editor saves (`pushSave`, `commit/file-save.ts`): a bean `checks-<short>` with the
 * person as author that writes `.gitstalk/checks.yml` and deletes the TOML, landing through the
 * pre-land check. Owners and maintainers convert, with their own identity, as for the rules.
 */
import type { RepositoryForViewer } from '@gitstalk/shared-race/collaborators';
import type { SaveAccess, SaveAutomationResult } from '@gitstalk/shared-race/automation-editor';
import { CHECKS_PATH, CHECKS_PATHS, isTomlChecks } from '@gitstalk/shared-race/checks-config';
import type { ChecksEditorRpc } from '@gitstalk/shared-race/checks-editor';
import { ConvertChecksInput } from '@gitstalk/shared-race/checks-editor';
import { tomlChecksToYaml } from '@gitstalk/shared-race/checks-yaml';
import { RunId } from '@gitstalk/shared-race/ids';
import type { Viewer } from '@gitstalk/shared-race/repos';
import type { RpcError, RpcResult } from '@gitstalk/shared-race/rpc';

import { handleOf } from '../actions/actions-audit';
import type { Deps } from '../deps';
import type { Current, Engine } from '../automations/editor-rpc';
import { DECIDING, currentFile, fileSaveOf, pushSave } from '../automations/editor-rpc';
import { accessResult, viewerPrincipal } from '../repos/access';

type Opened = { readonly repo: RepositoryForViewer; readonly engine: Engine };

export function checksEditorRpc(env: Env, deps: Deps): ChecksEditorRpc {
  const open = async (viewer: Viewer, repoId: string): Promise<RpcResult<Opened>> => {
    const allowed = await accessResult(deps.collaborators, await deps.registry.byId(repoId), {
      principal: viewerPrincipal(viewer),
      action: 'write',
      what: repoId,
    });
    if (!allowed.ok) return allowed;
    return {
      ok: true,
      value: { repo: allowed.value, engine: deps.run(RunId.parse(allowed.value.engine_id)) },
    };
  };
  return {
    convertChecks: async (viewer, repoId, raw) => {
      try {
        const input = ConvertChecksInput.safeParse(raw);
        if (!input.success) return invalid(input.error.issues[0]?.message ?? 'invalid request');
        const opened = await open(viewer, repoId);
        if (!opened.ok) return opened;
        const access = checksSaveAccess(opened.value.repo);
        if (access.kind === 'refused')
          return failed({ code: 'forbidden', status: 403, message: access.reason });
        return await convert(env, deps, { viewer, opened: opened.value, input: input.data });
      } catch (error: unknown) {
        deps.log.error('checks conversion failed', { error });
        return failed({ code: 'internal', status: 500, message: 'internal error' });
      }
    },
  };
}

/** Owners and maintainers convert; the checks decide what counts as green, so writers do not. */
export function checksSaveAccess(repo: RepositoryForViewer): SaveAccess {
  const role = repo.viewer_role;
  if (repo.archived_at !== null)
    return { kind: 'refused', reason: 'This repository is archived, so it is read-only.' };
  if (role === null || !DECIDING.has(role))
    return {
      kind: 'refused',
      reason: `Only maintainers and the owner change the checks; you have ${role === null ? 'no role' : `the ${role} role`}.`,
    };
  return { kind: 'allowed' };
}

async function convert(
  env: Env,
  deps: Deps,
  request: {
    readonly viewer: Viewer;
    readonly opened: Opened;
    readonly input: ConvertChecksInput;
  },
): Promise<RpcResult<SaveAutomationResult>> {
  const { engine, repo } = request.opened;
  const current = await currentChecks(engine);
  if (current === null) return invalid('This repository has no checks file to convert.');
  if (!isTomlChecks(current.path)) return invalid(`${current.path} is YAML already.`);
  const converted = tomlChecksToYaml(current.content);
  if (!converted.ok)
    return invalid(
      `${current.path} cannot be converted: ${converted.problems[0] ?? 'it is invalid'}`,
    );
  if (converted.yaml !== request.input.yaml)
    return failed({
      code: 'conflict',
      status: 409,
      message: 'The checks changed since this page opened. Reload to see them, then convert again.',
    });
  const save = fileSaveOf(
    { kind: 'checks' },
    {
      handle: await handleOf(env, request.viewer),
      role: repo.viewer_role,
      base: current.base,
      path: CHECKS_PATH,
      content: converted.yaml,
      deletes: current.path,
      message: `Convert ${current.path} to ${CHECKS_PATH}`,
      idempotencyKey: request.input.idempotencyKey,
    },
  );
  return pushSave(deps, engine, save);
}

/** The checks file on the latest landed commit (the first of `CHECKS_PATHS`), or null. */
async function currentChecks(
  engine: Engine,
): Promise<(Current & { readonly path: string; readonly content: string }) | null> {
  const files = await Promise.all(CHECKS_PATHS.map((path) => currentFile(engine, path)));
  for (const [index, file] of files.entries()) {
    const path = CHECKS_PATHS[index];
    if (file.content !== null && path !== undefined)
      return { ...file, path, content: file.content };
  }
  return null;
}

function failed<T>(error: RpcError): RpcResult<T> {
  return { ok: false, error };
}

function invalid<T>(message: string): RpcResult<T> {
  return failed({ code: 'invalid_request', status: 400, message });
}
