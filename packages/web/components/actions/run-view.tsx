/**
 * One run (`docs/claude-opus/25` §5.2, §5.3): what started it and on which commit, its facts
 * (status, wall time, minutes billed, inputs, the job graph: `RunStatus`, which keeps them live), annotations, the jobs' summary,
 * then the chosen job's steps and live log. Maintainers get Cancel and Re-run.
 *
 * The run itself renders at once; the chosen job's stored log (and the annotations read from
 * it, when the control plane sends none) streams in under Suspense boundaries, so a finished
 * job's whole log is never read before the page's first byte.
 */
import { Suspense } from 'react';

import { IntentLink as Link } from '../shell/intent-link';

import type { Annotation, Job, LogLine, RunDetail } from '../../src/actions/actions-contract';
import { annotationsFromLog } from '../../src/actions/log-view';
import { sectionOf } from '../../src/actions/run-view';
import type { ActionsAccess } from '../../src/server/actions-page';
import { MarkdownView } from '../repo-tabs/markdown-view';
import styles from './actions.module.css';
import { JobLog } from './job-log';
import { JobLogPending } from './job-log-pending';
import { RunStatus } from './run-status';

export function RunView(props: {
  readonly uid: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly apiBase: string;
  readonly run: RunDetail;
  readonly jobId: string | null;
  /** The chosen job's log as the page starts it (`initialLog`), still being read; null: none. */
  readonly lines: Promise<readonly LogLine[] | null> | null;
  readonly access: ActionsAccess | null;
  readonly nowMs: number;
}) {
  const { run, base, lines } = props;
  const section = sectionOf(run.workflowPath);
  const job = run.jobs.find((candidate) => candidate.id === props.jobId) ?? null;
  const logPath =
    job === null
      ? ''
      : `${props.apiBase}/runs/${encodeURIComponent(run.id)}/jobs/${encodeURIComponent(job.id)}/log`;
  return (
    <>
      <Link
        prefetch={false}
        className={styles.crumb}
        href={`${base}/${section}?workflow=${encodeURIComponent(run.workflowId)}`}
      >
        ← {run.workflowName} runs
      </Link>
      <RunStatus
        uid={props.uid}
        owner={props.owner}
        repo={props.repo}
        base={base}
        apiBase={props.apiBase}
        initial={run}
        nowMs={props.nowMs}
        jobId={job?.id ?? null}
        access={props.access}
      />
      {section === 'automations' ? <AutomationOutcome run={run} base={base} /> : null}
      {run.annotations.length > 0 || job === null || lines === null ? (
        <Annotations annotations={run.annotations} base={base} run={run} />
      ) : (
        <Suspense fallback={null}>
          <LogAnnotations job={job} lines={lines} base={base} run={run} />
        </Suspense>
      )}
      {run.summary === null ? null : (
        <section className={styles.box} aria-labelledby="summary-title">
          <div className={styles.boxHead}>
            <h2 id="summary-title">Summary</h2>
          </div>
          <MarkdownView text={run.summary} resolve={(href) => href} />
        </section>
      )}
      {job === null || lines === null ? null : (
        <Suspense
          key={job.id}
          fallback={<JobLogPending job={job} logPath={logPath} nowMs={props.nowMs} />}
        >
          <StreamedJobLog job={job} lines={lines} logPath={logPath} nowMs={props.nowMs} />
        </Suspense>
      )}
    </>
  );
}

/** The job's log once read; nothing when it could not be read (as before streaming). */
async function StreamedJobLog(props: {
  readonly job: Job;
  readonly lines: Promise<readonly LogLine[] | null>;
  readonly logPath: string;
  readonly nowMs: number;
}) {
  const lines = await props.lines;
  if (lines === null) return null;
  return <JobLog job={props.job} lines={lines} logPath={props.logPath} nowMs={props.nowMs} />;
}

/** The `::error` and `::warning` lines of the job's log, when the control plane sent none. */
async function LogAnnotations(props: {
  readonly job: Job;
  readonly lines: Promise<readonly LogLine[] | null>;
  readonly base: string;
  readonly run: RunDetail;
}) {
  const annotations = annotationsFromLog(props.job.id, (await props.lines) ?? []);
  return <Annotations annotations={annotations} base={props.base} run={props.run} />;
}

/**
 * What an automation's run did (`25` §7.8): the beans it pushed, its memory before and after
 * (each a commit on its memory ref, browsable), and its model calls and spend.
 */
function AutomationOutcome(props: { readonly run: RunDetail; readonly base: string }) {
  const outputs = props.run.jobs[0]?.outputs ?? {};
  const beans = (outputs['beans'] ?? '').split(',').filter((bean) => bean !== '');
  const before = outputs['memory_before'] ?? '';
  const after = outputs['memory_after'] ?? '';
  const usage = props.run.modelUsage;
  const memoryLink = (sha: string) => (
    <Link
      prefetch={false}
      className={styles.sha}
      href={`${props.base}/tree?ref=${encodeURIComponent(sha)}`}
      title="Browse the memory at this commit"
    >
      {sha.slice(0, 7)}
    </Link>
  );
  return (
    <section className={styles.box} aria-labelledby="outcome-title">
      <div className={styles.boxHead}>
        <h2 id="outcome-title">What it did</h2>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Beans pushed</dt>
          <dd>
            {beans.length === 0
              ? 'none'
              : beans.map((bean) => (
                  <Link
                    key={bean}
                    prefetch={false}
                    className={styles.bean}
                    href={`${props.base}/changes/${encodeURIComponent(bean)}`}
                  >
                    bean/{bean}
                  </Link>
                ))}
          </dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {before === '' && after === '' ? 'empty' : null}
            {before === '' && after !== '' ? <>new at {memoryLink(after)}</> : null}
            {before !== '' && before === after ? <>unchanged at {memoryLink(after)}</> : null}
            {before !== '' && after !== '' && before !== after ? (
              <>
                {memoryLink(before)} → {memoryLink(after)}
              </>
            ) : null}
          </dd>
        </div>
        {usage === null ? null : (
          <>
            <div>
              <dt>Model</dt>
              <dd className={styles.mono}>{usage.model ?? 'none'}</dd>
            </div>
            <div>
              <dt>Model calls</dt>
              <dd>
                {usage.calls} · {usage.inputTokens.toLocaleString('en-US')} in ·{' '}
                {usage.outputTokens.toLocaleString('en-US')} out
              </dd>
            </div>
            <div>
              <dt>Spend</dt>
              <dd>
                ${usage.costUsd.toFixed(4)} of ${usage.limitUsd.toFixed(2)}
              </dd>
            </div>
          </>
        )}
      </dl>
    </section>
  );
}

function Annotations(props: {
  readonly annotations: readonly Annotation[];
  readonly base: string;
  readonly run: RunDetail;
}) {
  if (props.annotations.length === 0) return null;
  const errors = props.annotations.filter((annotation) => annotation.level === 'error').length;
  const warnings = props.annotations.filter((annotation) => annotation.level === 'warning').length;
  return (
    <section className={styles.box} aria-labelledby="annotations-title">
      <div className={styles.boxHead}>
        <h2 id="annotations-title">Annotations</h2>
        <span className={styles.muted}>
          {errors} {errors === 1 ? 'error' : 'errors'}, {warnings}{' '}
          {warnings === 1 ? 'warning' : 'warnings'}
        </span>
      </div>
      <ul className={styles.annotations}>
        {props.annotations.map((annotation, index) => (
          <li key={index}>
            <span
              className={styles.annotationIcon}
              data-level={annotation.level}
              role="img"
              aria-label={annotation.level}
            />
            <span>{annotation.message}</span>
            <small>
              {props.run.jobs.find((job) => job.id === annotation.jobId)?.name ?? annotation.jobId}
              {annotation.path === null ? null : (
                <>
                  {' · '}
                  <Link
                    prefetch={false}
                    href={`${props.base}/blob/${annotation.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(props.run.sha)}${annotation.line === null ? '' : `#L${annotation.line}`}`}
                  >
                    {annotation.path}
                    {annotation.line === null ? '' : `:${annotation.line}`}
                  </Link>
                </>
              )}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}
