import { ActionsOff, ActionsShell } from '../../../../../components/actions/actions-shell';
import styles from '../../../../../components/actions/actions.module.css';
import { WorkflowsView } from '../../../../../components/actions/workflows-view';
import { runFilterOf } from '../../../../../src/actions/run-filters';
import { sectionOf } from '../../../../../src/actions/run-view';
import { actionsPage } from '../../../../../src/server/actions-page';
import type { RepositoryParams } from '../../../../../src/server/repository-page';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `Actions, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

/**
 * Automations → Actions (`docs/claude-opus/25` §5.1): the workflows and their runs. Anyone who
 * may read the repository sees them; maintainers and the owner may run a workflow by hand.
 * The workflows and the runs are read together.
 */
export default async function ActionsPage({ params, searchParams }: PageProps) {
  const page = await actionsPage(params);
  const filter = runFilterOf(await searchParams);
  if (page.actions === null)
    return (
      <ActionsShell page={page} view="actions" mode={null}>
        <ActionsOff />
      </ActionsShell>
    );
  const [listed, runs] = await Promise.all([
    page.actions.workflows(),
    page.actions.runs({ ...filter, kind: 'workflow' }),
  ]);
  // Automations have their own segment (doc 25 §7.8).
  const workflows = listed.ok
    ? {
        ...listed,
        value: listed.value.filter((workflow) => sectionOf(workflow.path) === 'actions'),
      }
    : listed;
  return (
    <ActionsShell
      page={page}
      view="actions"
      mode={page.actions.mode}
      workflowCount={workflows.ok ? workflows.value.length : undefined}
    >
      {workflows.ok ? (
        <WorkflowsView
          base={page.base}
          workflows={workflows.value}
          runs={runs.ok ? runs.value : null}
          runsError={runs.ok ? null : runs.error.message}
          filter={filter}
          access={page.access}
          nowMs={Date.now()}
        />
      ) : (
        <p className={`${styles.box} ${styles.empty}`}>
          The workflows could not be read: {workflows.error.message}
        </p>
      )}
    </ActionsShell>
  );
}
