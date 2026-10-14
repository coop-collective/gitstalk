/**
 * The self-approval rule (`docs/claude-opus/32-approval-rules.md` §5.2). Approving a held bean
 * is a person's decision. An agent session may carry it out for its person, but it must not
 * wave through a change it may have written itself: that would turn "a person approves" into
 * "the agent approves itself". So an approval from an MCP session is refused, unless the
 * person explicitly confirmed it (`confirm_owner_intent`), when the bean's latest push was made
 * for the same person and the gateway cannot show that a different agent session made it.
 *
 * Shown different, so allowed: a push by someone else; a save in the web editor (the person
 * in a browser); a push or server commit by another OAuth client's agent session. Not shown
 * different, so refused without the confirmation: the same OAuth client; the person's SSH key
 * or personal token (an agent on the person's machine pushes with exactly these); any push
 * whose credential was not recorded. The web's Approve button is the person themselves and
 * is never refused by this rule.
 */
import type { ApprovalClient } from '@gitstalk/shared-race/bean-approval';

export type SelfApprovalInput = {
  readonly bean: string;
  readonly client: ApprovalClient;
  /** The approving person's handle. */
  readonly approver: string;
  /** Who the bean's latest push was for, and which credential made it (`ProtectedAccess.pusher`). */
  readonly pushed: { readonly actor: string; readonly pusher: string | null };
};

/** Why this approval is refused under the rule, or null when it may go ahead. */
export function selfApprovalRefusal(input: SelfApprovalInput): string | null {
  const { client, pushed } = input;
  if (client.kind === 'web' || client.confirm_owner_intent === true) return null;
  if (pushed.actor.toLowerCase() !== input.approver.toLowerCase()) return null;
  if (isShownAnotherSession(pushed.pusher, client.session)) return null;
  return [
    `The latest push of ${input.bean} was made for @${pushed.actor} with ${pusherText(pushed.pusher)}, which may be this agent session:`,
    'an agent never approves its own change on its own initiative. Ask your person;',
    'if they tell you to approve it, call again with confirm_owner_intent: true, or they approve it on its page.',
  ].join(' ');
}

function isShownAnotherSession(pusher: string | null, session: string): boolean {
  if (pusher === 'web') return true;
  return pusher !== null && pusher.startsWith('oauth:') && pusher !== session;
}

function pusherText(pusher: string | null): string {
  if (pusher === null) return 'a credential that was not recorded';
  if (pusher.startsWith('oauth:')) return 'this same agent client';
  if (pusher.startsWith('ssh-key:')) return 'their SSH key';
  if (pusher.startsWith('personal-token:')) return 'their personal token';
  if (pusher === 'mcp' || pusher === 'token') return 'an MCP session';
  return 'their credential';
}
