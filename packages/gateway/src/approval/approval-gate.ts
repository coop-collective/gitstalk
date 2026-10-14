/**
 * The approval rules at a bean's pre-land check (`docs/claude-opus/32-approval-rules.md`).
 * Before the suite runs on a bean's merged tree, the gate reads the policy from the stalk (never
 * from the bean, so a bean cannot loosen its own rules), classifies the bean's change by code,
 * and then:
 *
 * - a writer limit the bean's principal breaks: the bean falls off, the way a protected path
 *   does (`guardRed`), naming the class and who may;
 * - `triage`: Clef picks `auto` or `card` within a time budget, else the rule does;
 * - `card`: the bean is held until a person approves this revision; the hold is a red that
 *   says so, and an approval re-submits the bean (`RunDO.approveBean`);
 * - `auto`: the check goes on as before.
 *
 * Every judgement leaves a receipt. It runs in the job, outside the engine's reducer, so a run
 * without approval rules replays exactly as before.
 */
import type {
  ChangeOrigin,
  Classification,
  RouteReceipt,
} from '@gitstalk/shared-race/approval-policy';
import {
  asksForSyntax,
  brokenWriterLimits,
  builtinClasses,
  classifyChange,
} from '@gitstalk/shared-race/approval-policy';
import type { ApprovalPolicy, PolicyResolution, Route } from '@gitstalk/shared-race/policy-file';
import { EMPTY_POLICY, POLICY_PATH, resolvePolicyFile } from '@gitstalk/shared-race/policy-file';
import { dialectOf, isCommentOnlyChange } from '@gitstalk/shared-race/code-tokens';
import type { ConfigFile } from '@gitstalk/shared-race/config-dir';
import type { Sha } from '@gitstalk/shared-race/ids';

import type { DecisionModel } from '@gitstalk/shared-ask/pick/decision-model';
import { askChoice } from '@gitstalk/shared-ask/pick/decision-model';

import type { CheckInstance, CheckResult } from '../engine/model';
import type { FileChange } from '../git/diff-text';
import type { LandingTree } from '../checks/check-store';
import { guardRed } from '../checks/repository-checks';
import { REMOTE_PREFIX as P } from '../push/push-messages';
import type { Approval } from './approval-store';
import type { TriageSubject } from './triage-question';
import { changeSize, triageQuestion } from './triage-question';

/** Classes whose beans the triage rule lets through when Clef does not answer. */
const LOW_RISK: ReadonlySet<string> = new Set(['comment-only', 'docs-only', 'tests-only']);
/**
 * Clef holds a bean for a person only when it is this sure. In the staging benchmark
 * (`research/race/runs/stg-scion-policy-*`) a coin-flip `card` (p=0.51) stalled the same bean on
 * every seed with nobody to approve it; below this the bean lands on its tests alone.
 */
export const CARD_MIN_PROBABILITY = 0.65;

/** What the gate needs from the engine's Durable Object. */
export type ApprovalHost = {
  /** The policy file on the stalk, and the stalk commit it was read at (null: unknown). */
  readPolicy(): Promise<{ readonly file: ConfigFile | null; readonly sha: string | null }>;
  /** Both sides of each changed file between two commits; null when a commit is missing. */
  changedFiles(range: {
    readonly from: Sha;
    readonly to: Sha;
  }): Promise<readonly FileChange[] | null>;
  /** The principal a bean's latest submission came from (`@handle`, or `agent:a3` in a race). */
  principal(task: string, instance: CheckInstance): string;
  /**
   * `decider` when the bean's latest push was a person's own and they may decide (an owner or
   * maintainer with a personal token or SSH key, as the Settings page pushes); else `agent`.
   */
  origin(task: string): ChangeOrigin;
  /** The bean revision an approval names: its pushed head, or null in a race. */
  revision(task: string): string | null;
  approval(task: string, revision: string | null): Approval | null;
  /** The bean's last receipt and the fingerprint of the change it judged. */
  previous(task: string): { readonly receipt: RouteReceipt; readonly fingerprint: string } | null;
  save(entry: { readonly receipt: RouteReceipt; readonly fingerprint: string }): void;
  /** Clef, or null when the Worker has no Workers AI binding (the rule answers). */
  readonly model: DecisionModel | null;
  now(): number;
};

/** The gate's verdict: the receipt, a red that holds the bean (or null), and push lines. */
export type Judgement = {
  readonly receipt: RouteReceipt;
  readonly hold: CheckResult | null;
  readonly lines: readonly string[];
};

/** Judges one bean merge before its suite runs. */
export async function judgeLanding(
  host: ApprovalHost,
  landing: LandingTree,
  instance: CheckInstance,
): Promise<Judgement> {
  const read = await host.readPolicy();
  const resolution = resolvePolicyFile(read.file);
  const source = {
    path: read.file?.path ?? null,
    sha: read.sha,
    valid: resolution.kind !== 'invalid',
  };
  const subject = {
    bean: landing.task,
    principal: host.principal(landing.task, instance),
    revision: host.revision(landing.task),
    policy: source,
    at: host.now(),
  };
  if (resolution.kind === 'missing') return withoutPolicy(host, landing, subject);
  const policy = policyFor(resolution);
  const diffRead = await changedFilesOf(host, landing, policy);
  const classification = classifyChange(policy, diffRead.files, host.origin(landing.task));
  const broken = brokenWriterLimits(classification, subject.principal);
  const fingerprint = fingerprintOf(classification, {
    policy: read.file,
    revision: subject.revision,
    files: landing.files,
  });
  if (broken.length > 0) {
    const refused = `${subject.principal} may not change class ${broken.map((limit) => limit.class).join(', ')}`;
    const receipt = receiptOf(subject, classification, {
      route: classification.route,
      by: 'policy',
      probability: null,
      latencyMs: null,
      refused,
      approval: { state: 'not-needed', actor: null },
    });
    host.save({ receipt, fingerprint });
    return {
      receipt,
      hold: writerRed(broken, subject.principal),
      lines: linesOf(receipt, resolution),
    };
  }
  const routed = await routeOf(host, {
    classification,
    fingerprint,
    task: landing.task,
    triage: () =>
      triageSubject(host, { landing, policy, classification, changes: diffRead.changes }),
  });
  const receipt = receiptOf(subject, classification, {
    ...routed,
    refused: null,
    approval: approvalOf(host, routed.route, subject),
  });
  host.save({ receipt, fingerprint });
  const hold = receipt.approval.state === 'awaiting' ? awaitingRed(receipt) : null;
  return { receipt, hold, lines: linesOf(receipt, resolution) };
}

type Subject = Pick<RouteReceipt, 'bean' | 'principal' | 'revision' | 'policy' | 'at'>;

/** A card's approval state for the bean's revision; any other route needs none. */
function approvalOf(host: ApprovalHost, route: Route, subject: Subject): RouteReceipt['approval'] {
  if (route !== 'card') return { state: 'not-needed', actor: null };
  const approval = host.approval(subject.bean, subject.revision);
  return approval === null
    ? { state: 'awaiting', actor: null }
    : { state: 'approved', actor: approval.actor };
}
type Routed = Pick<RouteReceipt, 'route' | 'by' | 'probability' | 'latencyMs'>;

/** No policy on the stalk: every bean is `auto`, as before the rules existed. */
function withoutPolicy(host: ApprovalHost, landing: LandingTree, subject: Subject): Judgement {
  const classes = builtinClasses(landing.files.map((path) => ({ path, commentOnly: false })));
  const receipt: RouteReceipt = {
    ...subject,
    classes: [...classes],
    route: 'auto',
    class: null,
    by: 'policy',
    probability: null,
    latencyMs: null,
    reviewers: [],
    refused: null,
    approval: { state: 'not-needed', actor: null },
  };
  host.save({ receipt, fingerprint: '' });
  return { receipt, hold: null, lines: [] };
}

function policyFor(resolution: Exclude<PolicyResolution, { kind: 'missing' }>): ApprovalPolicy {
  return resolution.kind === 'valid' ? resolution.policy : EMPTY_POLICY;
}

type DiffRead = {
  readonly files: readonly { path: string; commentOnly: boolean }[];
  /** The merge's diff, when it was read; null when paths decided alone. */
  readonly changes: readonly FileChange[] | null;
};

/**
 * The bean's changed files, each marked comment-only or not. File contents are read (one
 * diff of the merge, through the engine's read index) only when the policy routes
 * comment-only changes and every changed file is in a dialect the lexer judges; otherwise
 * paths decide alone.
 */
async function changedFilesOf(
  host: ApprovalHost,
  landing: LandingTree,
  policy: ApprovalPolicy,
): Promise<DiffRead> {
  const plain = landing.files.map((path) => ({ path, commentOnly: false }));
  const judgeable =
    asksForSyntax(policy) &&
    landing.files.length > 0 &&
    landing.files.every((path) => dialectOf(path) !== null);
  if (!judgeable) return { files: plain, changes: null };
  const changes = await host.changedFiles({ from: landing.onto, to: landing.sha });
  if (changes === null) return { files: plain, changes: null };
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const files = landing.files.map((path) => {
    const change = byPath.get(path);
    const commentOnly =
      change !== undefined &&
      change.binary !== true &&
      isCommentOnlyChange(path, change.before, change.after);
    return { path, commentOnly };
  });
  return { files, changes };
}

/**
 * What Clef reads about a bean it triages: the classes, the deciding class's description,
 * the paths and the diff's size (read now if the comment-only check did not read it).
 */
async function triageSubject(
  host: ApprovalHost,
  input: {
    readonly landing: LandingTree;
    readonly policy: ApprovalPolicy;
    readonly classification: Classification;
    readonly changes: readonly FileChange[] | null;
  },
): Promise<TriageSubject> {
  const { landing, classification } = input;
  const changes =
    input.changes ??
    (landing.files.length === 0
      ? null
      : await host.changedFiles({ from: landing.onto, to: landing.sha }));
  const decided = input.policy.classes.find((entry) => entry.name === classification.decidedBy);
  return {
    classes: classification.classes,
    decidedBy: classification.decidedBy,
    description: decided?.description ?? null,
    files: landing.files,
    size: changeSize(changes),
  };
}

/** The route: the class's own, or triage's answer (reused while the change is the same). */
async function routeOf(
  host: ApprovalHost,
  input: {
    readonly classification: Classification;
    readonly fingerprint: string;
    readonly task: string;
    /** What Clef reads, gathered only when it is asked. */
    readonly triage: () => Promise<TriageSubject>;
  },
): Promise<Routed> {
  const { classification } = input;
  if (classification.route !== 'triage')
    return { route: classification.route, by: 'policy', probability: null, latencyMs: null };
  const previous = host.previous(input.task);
  if (
    previous !== null &&
    previous.fingerprint === input.fingerprint &&
    previous.receipt.by !== 'policy'
  )
    return {
      route: previous.receipt.route,
      by: previous.receipt.by,
      probability: previous.receipt.probability,
      latencyMs: null,
    };
  const fallback: Route = classification.classes.some((name) => LOW_RISK.has(name))
    ? 'auto'
    : 'card';
  const answer = await askChoice(host.model, {
    id: 'route',
    ...triageQuestion(await input.triage()),
    fallback,
  });
  const chosen = answer.value.choice === 'auto' ? 'auto' : 'card';
  const latencyMs = host.model === null ? null : answer.ms;
  if (answer.kind === 'fell-back')
    return { route: chosen, by: 'rules', probability: null, latencyMs };
  const probability = answer.value.probabilities[chosen] ?? answer.confidence;
  if (chosen === 'card' && probability !== null && probability < CARD_MIN_PROBABILITY) {
    const auto = answer.value.probabilities['auto'] ?? null;
    return { route: 'auto', by: 'clef', probability: auto, latencyMs };
  }
  return { route: chosen, by: 'clef', probability, latencyMs };
}

function receiptOf(
  subject: Subject,
  classification: Classification,
  decided: Routed & Pick<RouteReceipt, 'refused' | 'approval'>,
): RouteReceipt {
  return {
    ...subject,
    ...decided,
    classes: [...classification.classes],
    class: classification.decidedBy,
    reviewers: [...classification.reviewers],
  };
}

function writerRed(broken: ReturnType<typeof brokenWriterLimits>, principal: string): CheckResult {
  const classes = broken.map((limit) => limit.class).join(', ');
  return guardRed({
    file: POLICY_PATH,
    name: 'changes a class it may not write',
    message: `${principal} may not change ${classes}`,
    output: [
      `This bean changes class ${classes}, which only some principals may change (writers in ${POLICY_PATH} on the stalk):`,
      ...broken.map((limit) => `  ${limit.class}: ${limit.allowed.join(', ')}`),
      `It came from ${principal}.`,
      'Drop those changes from the bean, or ask one of them to push it.',
    ],
  });
}

function awaitingRed(receipt: RouteReceipt): CheckResult {
  const why = receipt.class === null ? 'its classes' : `class ${receipt.class}`;
  const reviewers =
    receipt.reviewers.length === 0 ? '' : ` (reviewers: ${receipt.reviewers.join(', ')})`;
  return guardRed({
    file: receipt.policy.path ?? POLICY_PATH,
    name: 'awaits approval by a person',
    message: `routed to a person by ${why} (${receipt.by})`,
    output: [
      `This bean is routed to a person: ${why}, decided by ${receipt.by}${reviewers}.`,
      'Nothing in it needs fixing for this. An owner or maintainer approves this revision with Approve on the',
      "bean's page (Changes, Held), or has their agent call bean_approve. The approval re-submits it and its",
      'check runs again. A new push needs a new approval. Agents: ask your person; never approve your own bean.',
    ],
  });
}

function linesOf(receipt: RouteReceipt, resolution: PolicyResolution): readonly string[] {
  const classes = receipt.classes.length === 0 ? 'no class' : receipt.classes.join(', ');
  const lines = [
    `${P} approval rules: ${classes} -> ${receipt.route} (${receipt.by}${receipt.probability === null ? '' : `, p=${receipt.probability.toFixed(2)}`})`,
  ];
  if (resolution.kind === 'invalid')
    lines.push(`${P} ${resolution.path} on the stalk is invalid; only the built-in rules apply`);
  if (receipt.refused !== null) lines.push(`${P} refused: ${receipt.refused}`);
  if (receipt.approval.state === 'awaiting') lines.push(`${P} awaiting a person's approval`);
  if (receipt.approval.state === 'approved')
    lines.push(`${P} approved by ${receipt.approval.actor ?? 'a person'}`);
  return lines;
}

/**
 * What a triage depends on: the classes, the policy file's text and the bean's own change (its
 * pushed revision; in a race, which has no pushes, its files). Never the stalk commit the bean
 * merges onto: a re-check of the same change on a newer stalk reuses the answer instead of
 * asking Clef again. (The staging benchmark asked 60 to 66 times for 38 beans, and the same
 * push of one bean got auto, auto, auto and card as its merge base moved.)
 */
function fingerprintOf(
  classification: Classification,
  change: {
    readonly policy: ConfigFile | null;
    readonly revision: string | null;
    readonly files: readonly string[];
  },
): string {
  const text = JSON.stringify([
    classification.classes,
    change.policy === null ? null : [change.policy.path, change.policy.text],
    change.revision ?? change.files.toSorted(),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${text.length}`;
}
