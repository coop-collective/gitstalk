/**
 * The automation builder's contract (doc 25 §4 and §7.13): the web editor opens a file at the
 * latest landed commit, and a save is a bean, never a push to a line. The gateway builds the
 * commit from the file's new text on top of the version the editor opened, pushes it as
 * `bean/automation-<slug>-<short>` with the person's identity, and hands it to the engine like
 * any push. When the file changed since the editor opened it, the save is refused as `stale`
 * with the newer version, so the editor can merge field by field and save again.
 */
import { z } from 'zod';

import { AUTOMATIONS_DIR } from './actions';
import { IdempotencyKey } from './bean-commit';
import type { ViewerRole } from './collaborators';
import type { Viewer } from './repos';
import type { RpcResult } from './rpc';

/** Bean names are at most 32 characters (`TaskId`). */
const MAX_BEAN = 32;
const BEAN_PREFIX = 'automation-';

/** The version an editor started from: a commit, and the file's blob there (null: absent). */
export const AutomationBase = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  blob: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
});
export type AutomationBase = z.infer<typeof AutomationBase>;

/**
 * An automation file's path: `.gitstalk/automations/<name>.yml|.yaml|.md`, or the same under
 * `.beanstalk/automations/` (an existing file is edited where it is; new ones go to `.gitstalk/`).
 */
export const AutomationPath = z
  .string()
  .regex(
    /^\.(?:gitstalk|beanstalk)\/automations\/[a-z0-9][a-z0-9_-]{0,63}\.(?:ya?ml|md)$/,
    'an automation file is .gitstalk/automations/<lowercase-name>.yml',
  );

/** Whether the person may save, and if not, why (in their words). */
export type SaveAccess =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly reason: string };

/** What the editor opens with. */
export type AutomationSource = {
  readonly path: string;
  /** The latest landed commit and the file's blob there. */
  readonly base: AutomationBase;
  /** The file's text there; null when it does not exist (a new automation). */
  readonly content: string | null;
  readonly role: ViewerRole | null;
  readonly save: SaveAccess;
  /** Whether the person may start a test run of a draft (maintain or owner). */
  readonly canTestRun: boolean;
  /** The protected-path pattern of the checks file that covers the file, if any. */
  readonly protectedBy: string | null;
  /** The longest `timeout-minutes` runs here (the Actions job limit). */
  readonly maxTimeoutMinutes: number;
};

export const SaveAutomationInput = z.object({
  path: AutomationPath,
  base: AutomationBase,
  /** The file's new text; null deletes it. */
  content: z
    .string()
    .max(64 * 1024)
    .nullable(),
  /** The commit message's subject; a default names the change. */
  message: z.string().max(200).optional(),
  /** One per save attempt: a double click or a retried request replays the first bean. */
  idempotencyKey: IdempotencyKey.optional(),
});
export type SaveAutomationInput = z.input<typeof SaveAutomationInput>;

/** The file as it is now on the latest landed commit, and who changed it last. */
export type AutomationTheirs = {
  readonly base: AutomationBase;
  readonly content: string | null;
  /** The author's name on the newest commit that changed the file (null: unknown). */
  readonly author: string | null;
};

export type SaveAutomationResult =
  | {
      readonly kind: 'pushed';
      readonly bean: string;
      /** The bean's commit. */
      readonly commit: string;
    }
  | { readonly kind: 'stale'; readonly theirs: AutomationTheirs };

/** Where a saved bean stands, for the editor's inline status. */
export type AutomationBeanStatus = {
  readonly bean: string;
  readonly phase:
    | 'checking'
    | 'landed'
    | 'green'
    | 'red'
    | 'conflict'
    | 'waiting'
    | 'parked'
    | 'dropped';
  readonly reason: string;
  /** The landed commit on the sprout, once it landed. */
  readonly landedSha: string | null;
  /** Why it was sent back (failing tests, conflicting files), when it was. */
  readonly details: readonly string[];
};

export const TestAutomationInput = z.object({
  path: AutomationPath,
  content: z
    .string()
    .min(1)
    .max(64 * 1024),
});
export type TestAutomationInput = z.input<typeof TestAutomationInput>;

/** The gateway's builder RPC on its default entrypoint; the web authenticates the viewer. */
export type AutomationEditorRpc = {
  automationSource(
    viewer: Viewer,
    repoId: string,
    path: string,
  ): Promise<RpcResult<AutomationSource>>;
  saveAutomation(
    viewer: Viewer,
    repoId: string,
    input: SaveAutomationInput,
  ): Promise<RpcResult<SaveAutomationResult>>;
  automationBean(
    viewer: Viewer,
    repoId: string,
    bean: string,
  ): Promise<RpcResult<AutomationBeanStatus>>;
  /** Runs a draft once by hand, without saving it (maintain or owner). */
  testAutomation(
    viewer: Viewer,
    repoId: string,
    input: TestAutomationInput,
  ): Promise<RpcResult<{ readonly runId: string }>>;
};

/** The path of a new automation named `name`: its slug, under the automations folder. */
export function automationPathFor(name: string): string {
  return `${AUTOMATIONS_DIR}/${slugOf(name) || 'automation'}.yml`;
}

/** The bean a save pushes: `automation-<slug>-<short>`, at most 32 characters. */
export function automationBeanName(path: string, short: string): string {
  const file = path.split('/').at(-1) ?? path;
  const slug = slugOf(file.replace(/\.(?:ya?ml|md)$/, ''));
  const room = MAX_BEAN - BEAN_PREFIX.length - short.length - 1;
  const trimmed = slug.slice(0, room).replace(/-+$/, '');
  return `${BEAN_PREFIX}${trimmed || 'file'}-${short}`;
}

/** Lowercase letters, digits and single dashes. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
