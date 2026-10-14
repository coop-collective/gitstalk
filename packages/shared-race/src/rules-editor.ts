/**
 * Settings → Rules (`docs/claude-opus/32-approval-rules.md`): the approval rules' file opened at
 * the latest landed commit and saved the way the automation builder saves (doc 25 §7.13): a
 * commit built by the gateway from the new text, pushed as a bean with the signed-in person as
 * its author, landing through the pre-land check. Owners and maintainers may save; a person
 * who may decide is the decision, so the bean is not held for a card. Everyone else reads.
 */
import { z } from 'zod';

import type {
  AutomationBase,
  AutomationBeanStatus,
  SaveAccess,
  SaveAutomationResult,
} from './automation-editor';
import { AutomationBase as Base } from './automation-editor';
import { IdempotencyKey } from './bean-commit';
import type { ViewerRole } from './collaborators';
import type { Viewer } from './repos';
import type { RpcResult } from './rpc';

/** Bean names of rules saves: `rules-<short commit>`. */
export function rulesBeanName(short: string): string {
  return `rules-${short}`;
}

/** What the Rules page opens with. */
export type RulesSource = {
  /** Where the file is (or would be): `.gitstalk/policy.yml`, or an existing `.beanstalk/` one. */
  readonly path: string;
  readonly base: AutomationBase;
  /** The file's text on the latest landed commit; null when there is none. */
  readonly content: string | null;
  readonly role: ViewerRole | null;
  readonly save: SaveAccess;
};

export const SaveRulesInput = z.object({
  base: Base,
  content: z.string().max(32_000),
  /** The commit message's subject; a default names the change. */
  message: z.string().max(200).optional(),
  /** One per save attempt: a double click or a retried request replays the first bean. */
  idempotencyKey: IdempotencyKey.optional(),
});
export type SaveRulesInput = z.input<typeof SaveRulesInput>;

export type RulesEditorRpc = {
  rulesSource(viewer: Viewer, repoId: string): Promise<RpcResult<RulesSource>>;
  saveRules(
    viewer: Viewer,
    repoId: string,
    input: SaveRulesInput,
  ): Promise<RpcResult<SaveAutomationResult>>;
  /** Where a saved bean stands (the automation builder's `automationBean`). */
  rulesBean(viewer: Viewer, repoId: string, bean: string): Promise<RpcResult<AutomationBeanStatus>>;
};
