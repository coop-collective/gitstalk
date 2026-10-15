/**
 * The derived-history RPC (`DerivedRpc`) on the gateway's default entrypoint, for the web app
 * and the MCP server. Arguments are validated here; the engine id is looked up in the
 * registry (derived history exists for registered repositories, whose git data is in REPOS),
 * and the repository's `RepoDerivedDO` answers. Like the run reads, the binding is the trust
 * boundary: callers check the viewer's access first.
 */
import { z } from 'zod';

import type { DerivedRpc } from '@gitstalk/shared-race/derived';
import { RunId } from '@gitstalk/shared-race/ids';
import type { RpcResult } from '@gitstalk/shared-race/rpc';
import { isSafeRepoPath } from '@gitstalk/shared-race/task';

import type { Registry } from '../repos/registry';
import type { RepoDerivedDO } from './repo-derived-do';

const MAX_LINE = 10_000_000;

const Path = z.string().min(1).max(512).refine(isSafeRepoPath, 'a relative path inside the repo');
const Ref = z
  .string()
  .regex(/^(sprout|stalk|[0-9a-f]{40})$/, 'sprout, stalk or a commit sha of the sprout')
  .optional();
const Line = z.number().int().min(1).max(MAX_LINE).optional();

const WhyLinesArgs = z
  .object({ path: Path, ref: Ref, start: Line, end: Line })
  .refine(
    (args) => args.start === undefined || args.end === undefined || args.end >= args.start,
    'end must not be before start',
  );
const PathHistoryArgs = z.object({
  path: Path,
  ref: Ref,
  limit: z.number().int().min(1).max(100).optional(),
});

export type DerivedRpcDeps = {
  readonly registry: Pick<Registry, 'byEngine'>;
  readonly derived: (
    engine: RunId,
  ) => Pick<DurableObjectStub<RepoDerivedDO>, 'whyLines' | 'pathHistory'>;
};

export function derivedRpc(deps: DerivedRpcDeps): DerivedRpc {
  return {
    async whyLines(run, input) {
      const args = WhyLinesArgs.safeParse(input);
      if (!args.success) return invalid(args.error.issues[0]?.message ?? 'arguments');
      return forRepository(deps, run, (stub, source) => stub.whyLines({ ...args.data, ...source }));
    },
    async pathHistory(run, input) {
      const args = PathHistoryArgs.safeParse(input);
      if (!args.success) return invalid(args.error.issues[0]?.message ?? 'arguments');
      return forRepository(deps, run, (stub, source) =>
        stub.pathHistory({ ...args.data, ...source }),
      );
    },
  };
}

async function forRepository<T>(
  deps: DerivedRpcDeps,
  run: string,
  read: (
    stub: Pick<DurableObjectStub<RepoDerivedDO>, 'whyLines' | 'pathHistory'>,
    source: { readonly repo: string; readonly engine: string },
  ) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const engine = RunId.safeParse(run);
  if (!engine.success) return invalid(`not an engine id: ${run}`);
  const record = await deps.registry.byEngine(engine.data);
  if (record === null) {
    const message = 'derived history exists for repositories only, and this engine drives none';
    return { ok: false, error: { code: 'not_found', status: 404, message } };
  }
  return read(deps.derived(engine.data), { repo: record.artifacts_repo, engine: engine.data });
}

function invalid(message: string): {
  ok: false;
  error: { code: string; status: number; message: string };
} {
  return { ok: false, error: { code: 'invalid_request', status: 400, message } };
}
