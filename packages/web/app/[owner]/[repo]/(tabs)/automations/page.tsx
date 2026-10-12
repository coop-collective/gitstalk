import { isAutomationPath } from '@gitstalk/shared-race/actions';
import { IntentLink as Link } from '../../../../../components/shell/intent-link';

import { ActionsOff, ActionsShell } from '../../../../../components/actions/actions-shell';
import styles from '../../../../../components/actions/actions.module.css';
import { WorkflowsView } from '../../../../../components/actions/workflows-view';
import { runFilterOf } from '../../../../../src/actions/run-filters';
import { actionsPage } from '../../../../../src/server/actions-page';
import type { ViewerRole } from '../../../../../src/repositories/registry-client';
import type { RepositoryParams } from '../../../../../src/server/repository-page';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return { title: `Automations, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
}

const EXAMPLE = `# .gitstalk/automations/fix-red.yml
name: Fix red beans
on:
  bean_red:                 # a bean's pre-land check went red
  schedule: [{ cron: "0 9 * * 1" }]
permissions:
  beans: write              # may push fix beans (they pass pre-land like any other)
max-cost-usd: 0.50
prompt: |
  Read why the bean went red. Check your memory for this
  failure. Fix it in a new bean, and note what you did.`;

/**
 * Automations → Automations (`docs/claude-opus/25` §7.8): the agents defined by files in
 * `.gitstalk/automations/` on the stalk, their validation errors, what each runs as, its
 * memory, its last runs, and a Run button for maintainers. Runs use the Actions run views.
 */
export default async function AutomationsPage({ params, searchParams }: PageProps) {
  const page = await actionsPage(params);
  const filter = runFilterOf(await searchParams);
  if (page.actions === null)
    return (
      <ActionsShell page={page} view="automations" mode={null}>
        <ActionsOff />
      </ActionsShell>
    );
  const [listed, runs] = await Promise.all([
    page.actions.workflows(),
    page.actions.runs({ ...filter, kind: 'automation' }),
  ]);
  if (!listed.ok)
    return (
      <ActionsShell page={page} view="automations" mode={page.actions.mode}>
        <p className={`${styles.box} ${styles.empty}`}>
          The automations could not be read: {listed.error.message}
        </p>
      </ActionsShell>
    );
  const automations = listed.value.filter(
    (workflow) => workflow.automation !== null || isAutomationFile(workflow.path),
  );
  return (
    <ActionsShell
      page={page}
      view="automations"
      mode={page.actions.mode}
      automationCount={automations.length}
    >
      {automations.length === 0 ? (
        <NoAutomations newHref={canEdit(page.role) ? `${page.base}/automations/new` : null} />
      ) : (
        <WorkflowsView
          kind="automations"
          base={page.base}
          workflows={automations}
          runs={runs.ok ? runs.value : null}
          runsError={runs.ok ? null : runs.error.message}
          filter={filter}
          access={page.access}
          canEdit={canEdit(page.role)}
          nowMs={Date.now()}
        />
      )}
    </ActionsShell>
  );
}

/** People who may push beans open the builder; the gateway decides what a save may change. */
function canEdit(role: ViewerRole | null): boolean {
  return role === 'write' || role === 'maintain' || role === 'owner';
}

/** An invalid automation file has no facts, but it is still listed with its errors. */
function isAutomationFile(path: string): boolean {
  return isAutomationPath(path);
}

function NoAutomations({ newHref }: { readonly newHref: string | null }) {
  return (
    <section className={styles.box} aria-labelledby="automations-title">
      <div className={styles.coming}>
        <div>
          <h2 id="automations-title">No automations yet</h2>
          <p>
            An automation is an agent defined by a file in <code>.gitstalk/automations/</code> on
            the stalk. It runs on Gitstalk events (a red bean, a landing, a red validation, a
            decision), on a schedule or by hand, in a fresh container with the repository checked
            out, the event as context and its own memory, kept between runs in git.
          </p>
          <p>
            It acts as its own bot, may push fix beans that go through the pre-land check like
            anyone&rsquo;s, and never holds a model key: its model calls go through Gitstalk&rsquo;s
            proxy with a spend cap. Add the file in a bean; it is live when the stalk takes it.
          </p>
          {newHref === null ? null : (
            <p>
              <Link prefetch={false} className={styles.primary} href={newHref}>
                New automation
              </Link>
            </p>
          )}
        </div>
        <pre className={styles.yaml} aria-label="An example automation">
          {EXAMPLE}
        </pre>
      </div>
    </section>
  );
}
