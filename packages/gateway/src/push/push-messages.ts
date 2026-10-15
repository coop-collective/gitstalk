/**
 * The `remote:` lines of the git-native flow: what a push prints when its bean is received,
 * while its pre-land check runs, and at its verdict. Red verdicts name the failing tests, the
 * landed beans the bean collided with and their intent, and the fix; conflicts quote the
 * hunks and who landed the other side. The engine's rework prompt is the source for the parts
 * only it carries (the suite's output, the conflict hunks), with "trunk" read as the sprout.
 */

const OUTPUT_LINES = 12;
const HUNK_LINES = 40;
const INTENT_CHARS = 300;
/** What every `remote:` line of a push starts with. */
export const REMOTE_PREFIX = 'gitstalk:';
const P = REMOTE_PREFIX;
/** The prefix, or the `beanstalk:` one that verdicts stored before the rename carry. */
const ANY_REMOTE_PREFIX = /^(?:gitstalk|beanstalk):\s?/;

/** A stored `remote:` line without its prefix (either name). */
export function withoutRemotePrefix(line: string): string {
  return line.replace(ANY_REMOTE_PREFIX, '');
}

/** A landed bean as a verdict names it. */
export type BeanRef = { readonly bean: string; readonly title: string; readonly intent: string };

export type VerdictContext = {
  readonly bean: string;
  /** Where people (and agents) see the bean on the web. */
  readonly link: string | null;
};

/** The rework the engine started, as its `rework.start` event says. */
export type ReworkFacts = {
  readonly reason: string;
  readonly failing: readonly string[];
  readonly culprits: readonly BeanRef[];
  readonly conflicts: readonly string[];
};

export function receivedLines(input: {
  bean: string;
  sha: string;
  title: string;
  isNew: boolean;
  task: string | null;
  unknownOptions: readonly string[];
}): string[] {
  const what = input.isNew ? 'new bean' : 'bean';
  const lines = [`${P} ${what} ${input.bean} received at ${short(input.sha)}: "${input.title}"`];
  if (input.task !== null) lines.push(`${P}   for task ${input.task}`);
  for (const option of input.unknownOptions) lines.push(`${P}   ignored push option: ${option}`);
  return lines;
}

export function checkStartedLines(bean: string, wait: number | null): string[] {
  const lines = [
    `${P} pre-land check started: your change is merged onto the sprout and the whole suite runs on that tree`,
  ];
  if (wait === null)
    lines.push(
      `${P}   do not wait on it: take your next task; the verdict goes to refs/beans/${bean}/status`,
      `${P}   out of work? one blocking call wakes on your first verdict: ${waitCommand([bean])}`,
    );
  return lines;
}

/** The git command that waits for the first verdict of `beans` (all of mine when empty). */
export function waitCommand(beans: readonly string[], mode: 'any' | 'all' = 'any'): string {
  const named = beans.map((bean) => `-o bean=${bean} `).join('');
  return `git push ${named}origin HEAD:refs/wait/${mode}`;
}

export function statusHint(bean: string): string[] {
  return [
    `${P}   status: git fetch origin '+refs/beans/*:refs/beans/*' && git cat-file -p refs/beans/${bean}/status`,
  ];
}

export function linkLines(context: VerdictContext): string[] {
  return context.link === null ? [] : [`${P}   web: ${context.link}`];
}

export function landedLines(context: VerdictContext, landedSha: string): string[] {
  return [
    `${P} LANDED: ${context.bean} passed its pre-land check and is on the sprout as ${short(landedSha)}`,
    `${P}   it moves to the stalk once CI validates the sprout; git fetch origin sprout stalk`,
    ...linkLines(context),
  ];
}

export function redLines(context: VerdictContext, facts: ReworkFacts, prompt: string): string[] {
  const failing =
    facts.failing.length === 0 ? ['(the suite failed; see the output)'] : facts.failing;
  const lines = [
    `${P} RED: ${context.bean} was not landed. Merged onto the sprout, these tests failed:`,
    ...failing.slice(0, 12).map((test) => `${P}   - ${test}`),
  ];
  if (facts.failing.length > 12) lines.push(`${P}   (${facts.failing.length - 12} more)`);
  if (facts.culprits.length > 0) {
    lines.push(`${P} it collided with these landed beans (accepted behaviour; keep both):`);
    for (const culprit of facts.culprits) lines.push(...beanLines(culprit));
  }
  const output = promptOutput(prompt);
  if (output.length > 0) {
    lines.push(`${P} output:`, ...output.map((line) => `${P}   ${line}`));
  }
  return [...lines, ...fixLines(context.bean), ...linkLines(context)];
}

/** Why the approval rules held a bean, as a line names it: `class auth, decided by policy`. */
export function heldWhy(hold: {
  readonly classes: readonly string[];
  readonly class: string | null;
  readonly by: string;
}): string {
  const why =
    hold.class === null ? `classes ${hold.classes.join(', ') || 'none'}` : `class ${hold.class}`;
  return `${why}, decided by ${hold.by}`;
}

/**
 * A hold of the approval rules: the bean waits for a person, and its author has nothing to fix
 * (`approval/approval-gate.ts`). Never the red lines' "fix".
 */
export function heldLines(context: VerdictContext, why: string): string[] {
  return [
    `${P} HELD: ${context.bean} waits for a person's approval (${why}); nothing in it needs fixing`,
    `${P}   an owner or maintainer approves this revision on its page, or their agent calls bean_approve;`,
    `${P}   its pre-land check then runs again. A new push is judged again and needs a new approval.`,
    `${P}   do not push it again; ask your person to approve it, and keep working meanwhile;`,
    `${P}   once it is approved, ${waitCommand([context.bean])} wakes at its next verdict`,
    ...linkLines(context),
  ];
}

export function conflictLines(
  context: VerdictContext,
  facts: ReworkFacts,
  prompt: string,
): string[] {
  const lines = [
    `${P} CONFLICT: ${context.bean} does not merge onto the sprout. Conflicts in: ${facts.conflicts.join(', ') || '(see below)'}`,
  ];
  const block = promptConflictBlock(prompt);
  lines.push(...block.map((line) => `${P}   ${line}`));
  if (facts.culprits.length > 0 && block.length === 0) {
    lines.push(`${P} the sprout's side was written by:`);
    for (const culprit of facts.culprits) lines.push(...beanLines(culprit));
  }
  return [...lines, ...fixLines(context.bean), ...linkLines(context)];
}

export function stoppedLines(
  context: VerdictContext,
  phase: 'parked' | 'dropped',
  reason: string,
): string[] {
  const what = phase === 'parked' ? 'PARKED (it needs a person)' : 'DROPPED';
  return [`${P} ${what}: ${context.bean}: ${reason}`, ...linkLines(context)];
}

export function decisionLines(card: string, against: readonly string[]): string[] {
  return [
    `${P} decision card ${card}: the bean's spec contradicts ${against.join(', ')}; a person decides which behaviour stays`,
  ];
}

function fixLines(bean: string): string[] {
  return [
    `${P} fix: git fetch origin sprout && git rebase origin/sprout`,
    `${P}      then fix, commit and git push -f origin HEAD:refs/heads/bean/${bean}`,
    `${P}      and keep working; ${waitCommand([bean])} waits for its next verdict`,
  ];
}

function beanLines(ref: BeanRef): string[] {
  return [
    `${P}   - ${ref.bean} "${ref.title}"`,
    `${P}     intent: ${clip(ref.intent.replaceAll(/\s+/g, ' ').trim(), INTENT_CHARS)}`,
  ];
}

/** The suite output the engine's red prompt quotes, without stack frames, cut to its last lines. */
export function promptOutput(prompt: string): string[] {
  const match = /Output:\n```\n([\s\S]*?)\n```/.exec(prompt);
  const lines = (match?.[1] ?? '').split('\n').filter(isTelling);
  return lines.slice(-OUTPUT_LINES);
}

/** An output line worth a terminal line: not blank, not a stack frame, not a lone brace. */
function isTelling(line: string): boolean {
  const text = line.trim();
  return text !== '' && !text.startsWith('at ') && !/^[{}[\]()]+[,;]?$/.test(text);
}

/** The conflict prompt's hunks and authors (the trunk read as the sprout), cut to a screenful. */
export function promptConflictBlock(prompt: string): string[] {
  const start = prompt.search(/The conflicting hunks|The trunk's side was written/);
  const end = prompt.indexOf('Resolve every conflict');
  if (start < 0 || end < start) return [];
  const lines = prompt
    .slice(start, end)
    .replaceAll("the trunk's side", "the sprout's side")
    .replaceAll("The trunk's side", "The sprout's side")
    .replaceAll('<<<<<<< trunk', '<<<<<<< sprout')
    .replaceAll('>>>>>>> yours', '>>>>>>> your bean')
    .split('\n')
    .filter((line) => line !== '```' && line.trim() !== '');
  return lines.length > HUNK_LINES
    ? [...lines.slice(0, HUNK_LINES), `(${lines.length - HUNK_LINES} more lines)`]
    : lines;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
