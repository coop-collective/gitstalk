/**
 * The scopes a person ticks on the consent page (`/connect`, an agent's OAuth grant) and on
 * the SSH key approval page (`/settings/keys/add`, the setup script): what each one says, and
 * whether it starts ticked. `read` is always granted; `secrets` is never pre-ticked; `create`
 * is ticked when the agent or the setup script asked for it.
 */

/** One checkbox: the scope, its words, and how it starts. */
export type ScopeChoice = {
  readonly scope: string;
  readonly text: string;
  readonly checked: boolean;
  /** `read`: always granted, shown disabled. */
  readonly required: boolean;
  /** `secrets`: the person ticks it themselves, with a warning. */
  readonly optIn: boolean;
};

export const SCOPE_TEXT: Readonly<Record<string, string>> = {
  read: 'Read repositories, runs and workflow logs, and see secret names (never values)',
  collaborate: 'Post on beans, answer requests and read its inbox',
  write:
    'Push code to its own beans (never the stalk, never settings); where you maintain, run, re-run and cancel workflows',
  secrets:
    'Where you maintain: set and delete Actions secrets and variables, such as deploy tokens',
  create:
    'Create repositories in your namespace and in organizations whose members may create them (private unless you ask)',
};

/** Words for `create` on the key approval page: a key creates by pushing to a new address. */
export const KEY_CREATE_TEXT =
  'Create repositories where you may create them: by pushing to a new address or with the setup script’s create. New ones are private.';

/** Scopes the person must tick themselves, whatever the agent asked for. */
const OPT_IN: ReadonlySet<string> = new Set(['secrets']);

/** The consent page's checkboxes, in the order the server offers them. */
export function consentChoices(
  grantable: readonly string[],
  requested: readonly string[],
): ScopeChoice[] {
  return grantable.map((scope) => {
    const required = scope === 'read';
    const optIn = OPT_IN.has(scope);
    return {
      scope,
      text: SCOPE_TEXT[scope] ?? scope,
      checked: required || (requested.includes(scope) && !optIn),
      required,
      optIn,
    };
  });
}

/** The key approval page's extra checkbox: `create`, ticked, when the script asked for it. */
export function keyApprovalChoices(view: { readonly wantsCreate: boolean }): ScopeChoice[] {
  if (!view.wantsCreate) return [];
  return [{ scope: 'create', text: KEY_CREATE_TEXT, checked: true, required: false, optIn: false }];
}
