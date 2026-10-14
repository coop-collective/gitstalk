/**
 * `ask_repo`: the web app's Ask pipeline (`@gitstalk/shared-ask`), as JSON. The same view a
 * person sees for the question: its spec, the files it resolved, the beans and decisions it
 * found, and a link to that view. Bodies (diffs, file text) are left out; their handles stay.
 */
import type { Sha, TaskId } from '@gitstalk/shared-race/ids';

import type { Answer, MainPane, RailBlock } from '@gitstalk/shared-ask/ask/answer';
import { planAnswer } from '@gitstalk/shared-ask/ask/plan-answer';
import type { LineRef, ViewSpec } from '@gitstalk/shared-ask/ask/view-spec';
import type { BeanRecord } from '@gitstalk/shared-ask/forge/forge-source';

import { previewUrl } from './preview-link';
import type { ToolContext } from './tool-context';
import { clip } from './tool-context';

const BEANS_SHOWN = 12;
const INTENT_CHARS = 200;

export type AskAnswer = {
  readonly question: string;
  readonly headline: string;
  readonly spec: ViewSpec;
  readonly classified_by: string;
  readonly ref: { readonly name: LineRef; readonly sha: Sha };
  readonly files: readonly {
    readonly path: string;
    readonly reasons: readonly string[];
    readonly beans: readonly TaskId[];
  }[];
  /** What the main pane shows, as a handle (`file:<path>`, `diff:<from>..<to>`, `bean:<id>`). */
  readonly main: { readonly kind: MainPane['kind']; readonly handle: string | null };
  readonly beans: readonly {
    readonly bean: TaskId;
    readonly title: string;
    readonly intent: string;
    readonly status: string;
    readonly slot: string | null;
  }[];
  readonly decisions: readonly {
    readonly card: string;
    readonly bean: TaskId;
    readonly status: string;
    readonly outcome: string | null;
    readonly text: string | null;
  }[];
  /** Where the answer was decided: the route, the files and the sections, and by whom. */
  readonly picks: readonly {
    readonly decision: string;
    readonly chosen: readonly string[];
    readonly by: string;
    /** The model that answered (`Clef Flash`); null when the rule did. */
    readonly model: string | null;
    readonly confidence: number | null;
  }[];
  readonly preview_url: string;
};

export async function askRepo(
  ctx: ToolContext,
  question: string,
  ref: LineRef | null,
): Promise<AskAnswer> {
  const answer = await planAnswer({
    source: ctx.source,
    run: ctx.run,
    question,
    classifier: ctx.classifier,
    picker: ctx.picker,
    removed: [],
    ref,
    selection: { file: null, bean: null, view: null },
  });
  return {
    question,
    headline: answer.headline,
    spec: answer.spec,
    classified_by: answer.classifiedBy,
    ref: answer.ref,
    files: answer.fileSet.map((file) => ({
      path: file.path,
      reasons: file.reasons,
      beans: file.beans,
    })),
    main: { kind: answer.main.kind, handle: mainHandle(answer.main) },
    beans: beansOf(answer).slice(0, BEANS_SHOWN).map(toBean),
    decisions: answer.rail.flatMap((block) =>
      block.kind === 'decisions'
        ? block.cards.map((card) => ({
            card: card.card,
            bean: card.task,
            status: card.status,
            outcome: card.outcome,
            text: card.text,
          }))
        : [],
    ),
    picks: answer.picks.map((receipt) => ({
      decision: receipt.decision,
      chosen: receipt.chosen,
      by: receipt.by,
      model: receipt.model,
      confidence: receipt.confidence,
    })),
    preview_url: previewUrl(ctx.webUrl, ctx.run, { kind: 'ask', question, ref }),
  };
}

function mainHandle(main: MainPane): string | null {
  switch (main.kind) {
    case 'file':
      return `file:${main.file.path}@${main.file.sha}`;
    case 'diff':
      return `diff:${main.diff.from}..${main.diff.to}`;
    case 'bean':
      return `bean:${main.bean.id}`;
    case 'beans':
    case 'empty':
      return null;
    default:
      return assertNever(main);
  }
}

/** Beans from the main pane and the rail, each once, in the order they appear. */
function beansOf(answer: Answer): readonly BeanRecord[] {
  const fromMain = answer.main.kind === 'beans' ? answer.main.beans : [];
  const fromBean = answer.main.kind === 'bean' ? [answer.main.bean] : [];
  const fromRail = answer.rail.flatMap((block: RailBlock) =>
    block.kind === 'beans' || block.kind === 'promotion' ? block.beans : [],
  );
  const seen = new Set<string>();
  return [...fromBean, ...fromMain, ...fromRail].filter((bean) => {
    if (seen.has(bean.id)) return false;
    seen.add(bean.id);
    return true;
  });
}

function toBean(bean: BeanRecord): AskAnswer['beans'][number] {
  return {
    bean: bean.id,
    title: bean.title,
    intent: clip(bean.intent, INTENT_CHARS),
    status: bean.status,
    slot: bean.agent,
  };
}

function assertNever(value: never): never {
  throw new Error(`unexpected main pane ${JSON.stringify(value)}`);
}
