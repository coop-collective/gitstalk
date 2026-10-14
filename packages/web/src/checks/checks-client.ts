/**
 * Settings → Checks' adapter onto the gateway (`ChecksEditorRpc` on the GATEWAY binding): the
 * one-click conversion of a `checks.toml` to `.gitstalk/checks.yml`, its answer validated before
 * the app trusts it. A gateway without the method reads as "conversion is not available here".
 * Server-only.
 */
import { z } from 'zod';

import type { ChecksEditorRpc, ConvertChecksInput } from '@gitstalk/shared-race/checks-editor';
import type { RpcResult } from '@gitstalk/shared-race/rpc';

import { Theirs } from '../automations/editor-client';
import type { EditorOutcome } from '../automations/editor-client';

const ConvertResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pushed'), bean: z.string(), commit: z.string() }),
  z.object({ kind: z.literal('stale'), theirs: Theirs }),
]);
export type ChecksConvertResult = z.infer<typeof ConvertResult>;

export type ChecksClient = {
  convert(repoId: string, input: ConvertChecksInput): Promise<EditorOutcome<ChecksConvertResult>>;
};

/** The client for `viewer` (a user id), or null when the binding lacks the checks RPC. */
export function checksClient(binding: unknown, viewer: string | null): ChecksClient | null {
  if (typeof binding !== 'object' || binding === null || !isChecksRpc(binding)) return null;
  const rpc = binding;
  return {
    convert: async (repoId, input) => {
      const answer = await rpc.convertChecks(viewer, repoId, input).catch(() => null);
      return settle(answer);
    },
  };
}

function isChecksRpc(binding: object): binding is ChecksEditorRpc {
  return typeof Reflect.get(binding, 'convertChecks') === 'function';
}

function settle(answer: RpcResult<unknown> | null): EditorOutcome<ChecksConvertResult> {
  if (answer === null) return { ok: false, status: 502, message: 'The gateway did not answer.' };
  if (!answer.ok) return { ok: false, status: answer.error.status, message: answer.error.message };
  const parsed = ConvertResult.safeParse(answer.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: 502, message: 'The gateway answered in an unexpected shape.' };
}
