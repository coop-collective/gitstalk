import { ActionsOff, ActionsShell } from '../../../../../../components/actions/actions-shell';
import { RunView } from '../../../../../../components/actions/run-view';
import { focusJob, initialLog } from '../../../../../../src/actions/run-view';
import type { RunParams } from '../../../../../../src/server/run-page';
import { runPage } from '../../../../../../src/server/run-page';

type PageProps = {
  readonly params: RunParams;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `Run, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/**
 * One run: its graph and the chosen job's log (`?job=`, else the first failed or running job).
 * The run is read before anything streams (its layout's 404); the job's log so far streams in
 * after, then follows live.
 */
export default async function RunPage({ params, searchParams }: PageProps) {
  const [{ page, actions, run }, query] = await Promise.all([runPage(params), searchParams]);
  if (actions === null)
    return (
      <ActionsShell page={page} view="actions" mode={null}>
        <ActionsOff />
      </ActionsShell>
    );
  const asked = query['job'];
  const job = run.jobs.find((candidate) => candidate.id === asked) ?? focusJob(run.jobs);
  return (
    <ActionsShell page={page} view="actions" mode={actions.mode}>
      <RunView
        uid={page.user?.id ?? null}
        owner={page.record.owner.handle}
        repo={page.record.name}
        base={page.base}
        apiBase={`/api/repos/${encodeURIComponent(page.record.owner.handle)}/${encodeURIComponent(page.record.name)}/actions`}
        run={run}
        jobId={job?.id ?? null}
        lines={job === null ? null : initialLog(actions, run.id, job)}
        access={page.access}
        nowMs={Date.now()}
      />
    </ActionsShell>
  );
}
