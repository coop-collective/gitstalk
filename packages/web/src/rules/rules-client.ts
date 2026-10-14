/**
 * Settings → Rules' adapter onto the gateway (`RulesEditorRpc` on the GATEWAY binding), every
 * answer validated before the app trusts it. A gateway without the methods reads as "the rules
 * editor is not available here". Server-only.
 */
import { z } from 'zod';

import type { RpcResult } from '@gitstalk/shared-race/rpc';
import type { RulesEditorRpc, SaveRulesInput } from '@gitstalk/shared-race/rules-editor';

import { BeanStatus, Theirs } from '../automations/editor-client';
import type { EditorOutcome } from '../automations/editor-client';

export const RulesSource = z.object({
  path: z.string(),
  base: z.object({ commit: z.string(), blob: z.string().nullable() }),
  content: z.string().nullable(),
  role: z.enum(['read', 'write', 'maintain', 'owner']).nullable(),
  save: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('allowed') }),
    z.object({ kind: z.literal('refused'), reason: z.string() }),
  ]),
});
export type RulesSource = z.infer<typeof RulesSource>;

const SaveResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pushed'), bean: z.string(), commit: z.string() }),
  z.object({ kind: z.literal('stale'), theirs: Theirs }),
]);
export type RulesSaveResult = z.infer<typeof SaveResult>;

export type RulesClient = {
  source(repoId: string): Promise<EditorOutcome<RulesSource>>;
  save(repoId: string, input: SaveRulesInput): Promise<EditorOutcome<RulesSaveResult>>;
  bean(repoId: string, bean: string): Promise<EditorOutcome<BeanStatus>>;
};

const METHODS = ['rulesSource', 'saveRules', 'rulesBean'];

/** The client for `viewer` (a user id), or null when the binding lacks the rules RPC. */
export function rulesClient(binding: unknown, viewer: string | null): RulesClient | null {
  if (typeof binding !== 'object' || binding === null || !isRulesRpc(binding)) return null;
  const rpc = binding;
  return {
    source: (repoId) => settle(rpc.rulesSource(viewer, repoId), RulesSource),
    save: (repoId, input) => settle(rpc.saveRules(viewer, repoId, input), SaveResult),
    bean: (repoId, bean) => settle(rpc.rulesBean(viewer, repoId, bean), BeanStatus),
  };
}

function isRulesRpc(binding: object): binding is RulesEditorRpc {
  return METHODS.every((method) => typeof Reflect.get(binding, method) === 'function');
}

async function settle<T>(
  call: Promise<RpcResult<unknown>>,
  schema: z.ZodType<T>,
): Promise<EditorOutcome<T>> {
  const answer = await call.catch(() => null);
  if (answer === null) return { ok: false, status: 502, message: 'The gateway did not answer.' };
  if (!answer.ok) return { ok: false, status: answer.error.status, message: answer.error.message };
  const parsed = schema.safeParse(answer.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: 502, message: 'The gateway answered in an unexpected shape.' };
}
