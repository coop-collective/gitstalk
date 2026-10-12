/**
 * Automations → Actions (and → Automations, the same view over `.gitstalk/automations/`): the
 * workflows in a rail (each with its last run's state), the selected one's triggers,
 * compatibility notes or validation errors, an automation's agent and memory, "View file" and
 * "Run", then its runs (or every one's) with filters by workflow, status and line, newest first.
 */
import { isAutomationPath } from '@gitstalk/shared-race/actions';
import { IntentLink as Link } from '../shell/intent-link';

import type {
  AutomationFacts,
  RunFilter,
  RunPage,
  RunSummary,
  Workflow,
  WorkflowTrigger,
} from '../../src/actions/actions-contract';
import { STATUS_FILTER_WORDS, STATUS_FILTERS, filterHref } from '../../src/actions/run-filters';
import {
  actorLabel,
  dispatchOf,
  elapsedMs,
  eventWord,
  formatDuration,
  runTitle,
  stateOf,
  triggerLabel,
} from '../../src/actions/run-view';
import { timeAgo } from '../../src/repositories/when';
import type { ActionsAccess } from '../../src/server/actions-page';
import { AutoSubmitSelect } from '../explorer/auto-submit-select';
import styles from './actions.module.css';
import { RunWorkflow } from './run-workflow';
import { StateMark } from './state-mark';

export function WorkflowsView(props: {
  readonly base: string;
  readonly workflows: readonly Workflow[];
  readonly runs: RunPage | null;
  readonly runsError: string | null;
  readonly filter: RunFilter;
  readonly access: ActionsAccess | null;
  readonly nowMs: number;
  /** Which segment: GitHub workflows (default) or automations. */
  readonly kind?: Kind;
  /** Whether the viewer may open the automation builder (write or more; the save decides). */
  readonly canEdit?: boolean;
}) {
  const kind = props.kind ?? 'actions';
  const path = `${props.base}/${kind}`;
  const selected =
    props.workflows.find((workflow) => workflow.id === props.filter.workflow) ?? null;
  return (
    <div className={styles.layout}>
      <WorkflowRail path={path} workflows={props.workflows} filter={props.filter} kind={kind} />
      <section className={styles.box} aria-labelledby="workflow-title">
        {selected === null ? (
          <AllWorkflowsHead
            count={props.workflows.length}
            kind={kind}
            newHref={props.canEdit === true ? `${props.base}/automations/new` : null}
          />
        ) : (
          <WorkflowHead
            base={props.base}
            workflow={selected}
            access={props.access}
            canEdit={props.canEdit === true}
          />
        )}
        <Filters path={path} filter={props.filter} />
        <RunList
          base={props.base}
          kind={kind}
          path={path}
          runs={props.runs}
          error={props.runsError}
          filter={props.filter}
          nowMs={props.nowMs}
        />
      </section>
    </div>
  );
}

type Kind = 'actions' | 'automations';

const NO_RUNS_YET: Readonly<Record<Kind, string>> = {
  actions: 'No runs yet. A workflow runs when the stalk moves, on its schedule, or by hand.',
  automations: 'No runs yet. An automation runs on its Gitstalk events, its schedule, or by hand.',
};

function WorkflowRail(props: {
  readonly path: string;
  readonly workflows: readonly Workflow[];
  readonly filter: RunFilter;
  readonly kind: Kind;
}) {
  const withNotes = props.workflows.filter((workflow) => workflow.notes.length > 0).length;
  const invalid = props.workflows.filter((workflow) => workflow.error !== null).length;
  const label = props.kind === 'automations' ? 'Automations' : 'Workflows';
  return (
    <aside className={styles.rail} aria-label={label}>
      <h2>{label}</h2>
      <ul className={styles.workflows}>
        <li>
          <Link
            prefetch={false}
            href={filterHref(props.path, props.filter, { workflow: null })}
            aria-current={props.filter.workflow === undefined ? 'page' : undefined}
          >
            <span />
            <span className={styles.workflowName}>All {label.toLowerCase()}</span>
          </Link>
        </li>
        {props.workflows.map((workflow) => (
          <li key={workflow.id}>
            <Link
              prefetch={false}
              href={filterHref(props.path, props.filter, { workflow: workflow.id })}
              aria-current={props.filter.workflow === workflow.id ? 'page' : undefined}
              title={workflow.path}
            >
              {workflow.lastRun === null ? (
                <span />
              ) : (
                <StateMark state={stateOf(workflow.lastRun)} />
              )}
              <span className={styles.workflowName}>{workflow.name}</span>
            </Link>
          </li>
        ))}
      </ul>
      {invalid === 0 || props.kind !== 'automations' ? null : (
        <p className={styles.railNote}>
          <b>Invalid:</b> {invalid} {invalid === 1 ? 'file does' : 'files do'} not run until fixed.
        </p>
      )}
      {withNotes === 0 ? null : (
        <p className={styles.railNote}>
          <b>Compatibility:</b> {withNotes} {withNotes === 1 ? 'workflow has' : 'workflows have'}{' '}
          notes on what runs differently here.
        </p>
      )}
    </aside>
  );
}

function AllWorkflowsHead(props: {
  readonly count: number;
  readonly kind: Kind;
  readonly newHref: string | null;
}) {
  const { count, kind } = props;
  if (kind === 'automations')
    return (
      <div className={styles.workflowHead}>
        <div>
          <h2 id="workflow-title">All automations</h2>
          <p className={styles.workflowPath}>
            {count} {count === 1 ? 'automation' : 'automations'} in .gitstalk/automations: agents
            that run on Gitstalk events, on schedule or by hand, each with its own memory
          </p>
        </div>
        {props.newHref === null ? null : (
          <div className={styles.workflowTools}>
            <Link prefetch={false} className={styles.primary} href={props.newHref}>
              New automation
            </Link>
          </div>
        )}
      </div>
    );
  return (
    <div className={styles.workflowHead}>
      <div>
        <h2 id="workflow-title">All workflows</h2>
        <p className={styles.workflowPath}>
          {count} {count === 1 ? 'workflow' : 'workflows'} in .github/workflows, run when the stalk
          moves, on schedule or by hand
        </p>
      </div>
    </div>
  );
}

function WorkflowHead(props: {
  readonly base: string;
  readonly workflow: Workflow;
  readonly access: ActionsAccess | null;
  readonly canEdit: boolean;
}) {
  const { workflow } = props;
  const isAutomation = isAutomationPath(workflow.path);
  const file = workflow.path.split('/').at(-1) ?? workflow.path;
  const dispatch = dispatchOf(workflow);
  return (
    <div className={styles.workflowHead}>
      <div>
        <h2 id="workflow-title">{workflow.name}</h2>
        <p className={styles.workflowPath}>
          <Link
            prefetch={false}
            href={`${props.base}/blob/${workflow.path.split('/').map(encodeURIComponent).join('/')}`}
          >
            {workflow.path}
          </Link>
        </p>
      </div>
      <div className={styles.workflowTools}>
        <Link
          prefetch={false}
          className={styles.button}
          href={`${props.base}/blob/${workflow.path.split('/').map(encodeURIComponent).join('/')}`}
        >
          View file
        </Link>
        {isAutomation && props.canEdit ? (
          <Link
            prefetch={false}
            className={styles.button}
            href={`${props.base}/automations/edit/${encodeURIComponent(file)}`}
          >
            Edit
          </Link>
        ) : null}
        {isAutomation ? null : (
          <span
            className={styles.button}
            aria-disabled="true"
            title="Editing in the browser lands as a bean; coming"
          >
            Edit <span className={styles.soon}>coming</span>
          </span>
        )}
        {dispatch !== null && props.access !== null && workflow.error === null ? (
          <RunWorkflow
            workflowId={workflow.id}
            workflowName={workflow.name}
            inputs={dispatch.inputs}
            access={props.access}
          />
        ) : null}
      </div>
      {workflow.automation === null ? null : <AutomationFactsList facts={workflow.automation} />}
      <ul className={styles.triggers} aria-label="Triggers">
        {workflow.triggers.map((trigger, index) => (
          <li
            key={index}
            className={styles.trigger}
            data-support={trigger.event === 'other' ? trigger.support : 'runs'}
            title={trigger.event === 'other' ? trigger.reason : undefined}
          >
            {triggerLabel(trigger)}
            {supportSuffix(trigger)}
          </li>
        ))}
      </ul>
      {workflow.error === null ? null : <p className={styles.parseError}>{workflow.error}</p>}
      {workflow.notes.length === 0 ? null : (
        <ul className={styles.notes} aria-label="Compatibility notes">
          {workflow.notes.map((note) => (
            <li key={note.text} data-level={note.level}>
              {note.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An automation's agent, permissions, secrets, memory and limits, as its file says. */
function AutomationFactsList(props: { readonly facts: AutomationFacts }) {
  const { facts } = props;
  return (
    <div className={styles.automationFacts}>
      <dl className={styles.facts}>
        <div>
          <dt>Runs</dt>
          <dd>
            {facts.harness === 'agent' ? (
              <>
                agent on <span className={styles.mono}>{facts.model}</span>
              </>
            ) : (
              'a shell script'
            )}
          </dd>
        </div>
        <div>
          <dt>Acts as</dt>
          <dd className={styles.mono}>{facts.actor}</dd>
        </div>
        <div>
          <dt>May</dt>
          <dd>{facts.beansWrite ? 'read and push beans' : 'read'}</dd>
        </div>
        <div>
          <dt>Secrets</dt>
          <dd>{facts.secrets.length === 0 ? 'none' : facts.secrets.join(', ')}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {facts.memoryRef === null ? (
              'off'
            ) : (
              <span
                className={styles.mono}
                title={`git fetch origin ${facts.memoryRef}; each run's memory commit is linked on its page`}
              >
                {facts.memoryRef}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Limits</dt>
          <dd>
            {facts.timeoutMinutes} min
            {facts.harness === 'agent'
              ? ` · ${facts.maxTurns} turns · $${facts.maxCostUsd.toFixed(2)}`
              : ''}
          </dd>
        </div>
      </dl>
      <pre className={styles.yaml} aria-label={facts.harness === 'agent' ? 'Prompt' : 'Script'}>
        {facts.prompt}
      </pre>
    </div>
  );
}

/** What follows a trigger that does not run yet, or never will here. */
function supportSuffix(trigger: WorkflowTrigger): string {
  if (trigger.event !== 'other') return '';
  return trigger.support === 'never' ? ': never here' : ': soon';
}

function Filters(props: { readonly path: string; readonly filter: RunFilter }) {
  const { filter } = props;
  const filtered = filter.status !== undefined || filter.branch !== undefined;
  return (
    <form method="get" action={props.path} className={styles.filters}>
      {filter.workflow === undefined ? null : (
        <input type="hidden" name="workflow" value={filter.workflow} />
      )}
      <label htmlFor="run-status">
        Status
        <AutoSubmitSelect
          id="run-status"
          name="status"
          defaultValue={filter.status ?? ''}
          className={styles.select}
        >
          <option value="">any</option>
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {STATUS_FILTER_WORDS[status]}
            </option>
          ))}
        </AutoSubmitSelect>
      </label>
      <label htmlFor="run-branch">
        Line
        <AutoSubmitSelect
          id="run-branch"
          name="branch"
          defaultValue={filter.branch ?? ''}
          className={styles.select}
        >
          <option value="">any</option>
          <option value="stalk">stalk (main)</option>
          <option value="sprout">sprout</option>
        </AutoSubmitSelect>
      </label>
      <noscript>
        <button type="submit" className={styles.filterGo}>
          Filter
        </button>
      </noscript>
      {filtered ? (
        <Link
          prefetch={false}
          className={styles.clear}
          href={filterHref(props.path, filter, { status: null, branch: null })}
        >
          Clear filters
        </Link>
      ) : null}
    </form>
  );
}

function RunList(props: {
  readonly base: string;
  readonly kind: Kind;
  readonly path: string;
  readonly runs: RunPage | null;
  readonly error: string | null;
  readonly filter: RunFilter;
  readonly nowMs: number;
}) {
  if (props.runs === null)
    return <p className={styles.empty}>Runs could not be read: {props.error ?? 'no answer'}.</p>;
  if (props.runs.runs.length === 0)
    return (
      <p className={styles.empty}>
        {props.filter.status === undefined && props.filter.branch === undefined
          ? NO_RUNS_YET[props.kind]
          : 'No runs match these filters.'}
      </p>
    );
  const next = props.runs.next;
  return (
    <>
      <ol className={styles.runs} aria-label="Runs">
        {props.runs.runs.map((run) => (
          <li key={run.id}>
            <RunRow run={run} base={props.base} kind={props.kind} nowMs={props.nowMs} />
          </li>
        ))}
      </ol>
      {next === null ? null : (
        <Link
          prefetch={false}
          className={styles.more}
          href={filterHref(props.path, props.filter, { before: next })}
        >
          Older runs
        </Link>
      )}
    </>
  );
}

function RunRow(props: {
  readonly run: RunSummary;
  readonly base: string;
  readonly kind: Kind;
  readonly nowMs: number;
}) {
  const { run } = props;
  const state = stateOf(run);
  return (
    <div className={styles.run}>
      <StateMark state={state} />
      <span className={styles.runTitle}>
        <Link
          prefetch={false}
          href={`${props.base}/${props.kind}/runs/${encodeURIComponent(run.id)}`}
        >
          {runTitle(run)}
        </Link>
      </span>
      <span className={styles.runMeta}>
        <b>
          {run.workflowName} #{run.number}
        </b>
        <span>{eventWord(run.event)}</span>
        <Link
          prefetch={false}
          className={styles.sha}
          href={`${props.base}/tree?ref=${encodeURIComponent(run.sha)}`}
          title="Browse the files at this commit"
        >
          {run.sha.slice(0, 7)}
        </Link>
        {run.bean === null ? null : (
          <Link
            prefetch={false}
            className={styles.bean}
            href={`${props.base}/changes/${encodeURIComponent(run.bean)}`}
          >
            bean/{run.bean}
          </Link>
        )}
        <span>{actorLabel(run.actor)}</span>
      </span>
      <span className={styles.runTimes}>
        <time dateTime={run.createdAt}>{timeAgo(run.createdAt, props.nowMs)}</time>
        <span title="Wall time">{formatDuration(elapsedMs(run, props.nowMs)) || 'waiting'}</span>
        <span title="Minutes billed: each job rounded up">{run.billedMinutes} min billed</span>
      </span>
    </div>
  );
}
