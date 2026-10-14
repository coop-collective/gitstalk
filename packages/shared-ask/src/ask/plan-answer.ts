/**
 * Ask, end to end (`docs/claude-opus/13` §2): classify the question, resolve its entities to
 * files, query the source, and arrange the explorer's fixed layout for the answer.
 */
import type { RunId } from '@gitstalk/shared-race/ids';

import type { ForgeSource } from '../forge/forge-source';
import type { PickReceipt, Picker } from '../pick/picker';
import { rulesPicker } from '../pick/picker';
import { isInFlight } from '../race/race-counters';
import type { Answer, FileBadges, TreeModel } from './answer';
import type { SectionId } from './answer-picks';
import { pickRoute, pickSections } from './answer-picks';
import { applyRemovals, chipsFor, parseRemovals } from './chips';
import type { Classification, Classifier } from './classifier';
import type { FileSet } from './file-set';
import { failingTestFiles, fileSetFor, inFlightBeans, unpromoted } from './file-set';
import { latestCulprit, mainPaneFor } from './main-pane';
import type { PlanContext, Selection } from './plan-context';
import { filesChanged, loadPlanContext } from './plan-context';
import { railFor } from './rail';
import type { LineRef } from './view-spec';
import { CATALOG, exploreSpec } from './view-spec';

export type AskInput = {
  readonly source: ForgeSource;
  readonly run: RunId;
  readonly question: string;
  readonly classifier: Classifier;
  /** `x=` values: chips the user removed. */
  readonly removed: readonly string[];
  /** The line picked in the ref selector, overriding the question's. */
  readonly ref: LineRef | null;
  readonly selection: Selection;
  /** Orders what the answer shows (`docs/claude-opus/14` §5); the rules when absent. */
  readonly picker?: Picker;
};

export async function planAnswer(input: AskInput): Promise<Answer> {
  const picker = input.picker ?? rulesPicker;
  const classification = await classify(input);
  const routed =
    input.question.trim() === ''
      ? null
      : await pickRoute({
          picker,
          question: input.question,
          spec: classification.spec,
          classifiedBy: classification.by,
        });
  const removals = parseRemovals(input.removed);
  const parsed = applyRemovals(routed?.spec ?? classification.spec, removals);
  const spec =
    input.ref === null ? parsed : { ...parsed, range: { ...parsed.range, ref: input.ref } };
  const ctx = await loadPlanContext({
    source: input.source,
    run: input.run,
    spec,
    removals,
    selection: input.selection,
    picker,
  });
  const set = await fileSetFor(ctx);
  const [main, rail] = await Promise.all([mainPaneFor(ctx, set), railFor(ctx, set)]);
  const available: readonly SectionId[] = ['main', ...rail.map((block) => block.kind)];
  const sections = await pickSections({
    picker,
    question: input.question,
    cls: spec.class,
    available,
  });
  const picks: readonly (PickReceipt | null)[] = [routed?.receipt ?? null, set.receipt, sections];
  return {
    question: input.question,
    spec,
    view: CATALOG[spec.class].view,
    classifiedBy:
      routed === null || routed.receipt.by === 'rules' ? classification.by : routed.receipt.by,
    chips: chipsFor(spec, set.ranked, set.files),
    ref: { name: ctx.state.meta?.policy === 'queue' ? 'stalk' : ctx.refName, sha: ctx.tree.sha },
    policy: ctx.state.meta?.policy ?? null,
    at: ctx.now,
    fileSet: set.ranked,
    tree: treeModel(ctx, set),
    main,
    rail,
    headline: headline(ctx, set),
    sections: available
      .filter((id) => sections.chosen.includes(id))
      .toSorted((a, b) => sections.chosen.indexOf(a) - sections.chosen.indexOf(b)),
    picks: picks.filter((receipt): receipt is PickReceipt => receipt !== null),
  };
}

function classify(input: AskInput): Promise<Classification> {
  const ref = input.ref ?? 'sprout';
  if (input.question.trim() === '')
    return Promise.resolve({ spec: exploreSpec(ref), by: 'keywords' });
  return input.classifier.classify(input.question, ref);
}

function treeModel(ctx: PlanContext, set: FileSet): TreeModel {
  const filtered = CATALOG[ctx.spec.class].view.tree === 'filtered' && set.files.length > 0;
  const files = filtered ? set.files : [...ctx.treePaths];
  const changes = countBy(
    ctx.range.commits.flatMap((commit) => commit.files.map((file) => file.path)),
  );
  const inFlight = countBy(inFlightBeans(ctx).flatMap((bean) => bean.files));
  const red = new Set(failingTestFiles(ctx));
  const decisions = countBy(ctx.decisions.flatMap((card) => card.files));
  const reasons = new Map(set.ranked.map((file) => [file.path, file.reasons]));
  const badges: Record<string, FileBadges> = {};
  for (const path of files) {
    badges[path] = {
      changes: changes.get(path) ?? 0,
      inFlight: inFlight.get(path) ?? 0,
      red: red.has(path) ? 1 : 0,
      decisions: decisions.get(path) ?? 0,
      reasons: reasons.get(path) ?? [],
    };
  }
  return { mode: filtered ? 'filtered' : 'full', files, badges, matched: set.files };
}

function countBy(values: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** One sentence that states what the answer found, from the computed results. */
function headline(ctx: PlanContext, set: FileSet): string {
  const files = count(set.files.length, 'file');
  const about = ctx.spec.entities.feature === null ? '' : ` about ${ctx.spec.entities.feature}`;
  switch (ctx.spec.class) {
    case 'recent-changes':
    case 'who-why': {
      const wanted = new Set(set.files);
      const landings = ctx.range.commits.filter((commit) =>
        commit.files.some((file) => wanted.has(file.path)),
      );
      const touched = set.files.filter((path) => filesChanged(ctx.range.commits).has(path)).length;
      return `${count(touched, 'file')}${about} changed in ${count(landings.length, 'landing')} ${rangeWords(ctx)}.`;
    }
    case 'in-flight': {
      const inFlight = ctx.beans.filter((bean) => isInFlight(bean.phase));
      const wanted = new Set(set.files);
      const feature = ctx.spec.entities.feature?.toLowerCase() ?? '';
      const here = inFlight.filter((bean) =>
        bean.files.some(
          (file) => wanted.has(file) || (feature !== '' && file.toLowerCase().includes(feature)),
        ),
      ).length;
      if (inFlight.length === 0) return 'Nothing is in flight right now.';
      return ctx.spec.entities.feature === null
        ? `${count(inFlight.length, 'bean')} in flight.`
        : `${count(inFlight.length, 'bean')} in flight; ${here} touch ${ctx.spec.entities.feature}.`;
    }
    case 'what-broke': {
      const reds = ctx.state.totals.redValidations;
      const culprit = latestCulprit(ctx);
      return `${count(reds, 'red validation')}${culprit === undefined ? '' : `; newest culprit ${culprit}`}.`;
    }
    case 'pending-promotion': {
      const waiting = unpromoted(ctx).length;
      return waiting === 0
        ? 'The stalk has everything on the sprout.'
        : `${count(waiting, 'commit')} on the sprout wait for the stalk.`;
    }
    case 'decisions':
      return `${count(ctx.decisions.length, 'decision card')} in this run${about}.`;
    case 'tests-for':
      return `${files}${about}: the code and the tests that cover it.`;
    case 'agent-activity':
      return `${ctx.spec.entities.agent ?? 'The agent'} touched ${files}.`;
    case 'bean':
      return ctx.spec.entities.bean === null
        ? 'Name a bean to see it.'
        : `Bean ${ctx.spec.entities.bean}: ${files}.`;
    case 'explore':
      if (set.files.length === 0) return `The repository at the ${ctx.refName}.`;
      return `${files} match${set.files.length === 1 ? 'es' : ''} ${ctx.spec.entities.feature ?? 'the question'}.`;
    default:
      return files;
  }
}

function rangeWords(ctx: PlanContext): string {
  return ctx.spec.range.minutes === null
    ? 'this run'
    : `the last ${ctx.spec.range.minutes} minutes`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
