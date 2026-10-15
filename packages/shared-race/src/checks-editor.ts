/**
 * Settings → Checks' one write (`docs/claude-opus/24-checks-config.md`): converting a
 * repository's older `checks.toml` to `.gitstalk/checks.yml`. The gateway converts the file on
 * the latest landed commit with `tomlChecksToYaml` and saves it the way the rules editor saves
 * (doc 25 §7.13): one bean with the person as its author that writes the YAML and deletes the
 * TOML, landing through the pre-land check. Owners and maintainers convert; the YAML the page
 * showed is sent back, so a file that changed since is never converted unseen.
 */
import { z } from 'zod';

import type { SaveAutomationResult } from './automation-editor';
import { IdempotencyKey } from './bean-commit';
import type { Viewer } from './repos';
import type { RpcResult } from './rpc';

/** Bean names of checks conversions: `checks-<short commit>`. */
export function checksBeanName(short: string): string {
  return `checks-${short}`;
}

export const ConvertChecksInput = z.object({
  /** The `checks.yml` the page showed: refused when the TOML now converts to anything else. */
  yaml: z.string().max(32_000),
  /** One per attempt: a double click or a retried request replays the first bean. */
  idempotencyKey: IdempotencyKey.optional(),
});
export type ConvertChecksInput = z.input<typeof ConvertChecksInput>;

export type ChecksEditorRpc = {
  convertChecks(
    viewer: Viewer,
    repoId: string,
    input: ConvertChecksInput,
  ): Promise<RpcResult<SaveAutomationResult>>;
};
