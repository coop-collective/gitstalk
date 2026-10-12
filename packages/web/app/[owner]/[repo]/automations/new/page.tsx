import { AUTOMATIONS_DIR } from '@gitstalk/shared-race/actions';
import { IntentLink as Link } from '../../../../../components/shell/intent-link';

import { ActionsShell } from '../../../../../components/actions/actions-shell';
import { AutomationBuilder } from '../../../../../components/automations/automation-builder';
import styles from '../../../../../components/automations/builder.module.css';
import { AUTOMATION_TEMPLATES, templateOf } from '../../../../../src/automations/templates';
import { actionsPage } from '../../../../../src/server/actions-page';
import { builderStart } from '../../../../../src/server/automation-builder-page';
import type { RepositoryParams } from '../../../../../src/server/repository-page';

type PageProps = {
  readonly params: RepositoryParams;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

export async function generateMetadata({ params }: PageProps) {
  const { owner, repo } = await params;
  return {
    title: `New automation, ${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`,
  };
}

/**
 * Automations → New (doc 25 §7.13): pick a template, then the builder with it. Saving pushes
 * a bean that adds the file; it is live when the stalk takes it.
 */
export default async function NewAutomationPage({ params, searchParams }: PageProps) {
  const page = await actionsPage(params);
  const chosen = (await searchParams)['template'];
  const templateId = typeof chosen === 'string' ? chosen : null;
  const shell = (children: React.ReactNode) => (
    <ActionsShell page={page} view="automations" mode={page.actions?.mode ?? null}>
      {children}
    </ActionsShell>
  );
  if (templateId === null)
    return shell(
      <section className={styles.picker} aria-labelledby="templates-title">
        <h2 id="templates-title">New automation</h2>
        <p className={styles.hint}>
          Start from a template. Everything stays editable, in the form and in the YAML.
        </p>
        <ul className={styles.templates}>
          {AUTOMATION_TEMPLATES.map((template) => (
            <li key={template.id}>
              <Link
                prefetch={false}
                href={`${page.base}/automations/new?template=${encodeURIComponent(template.id)}`}
              >
                <b>{template.title}</b>
                <span>{template.summary}</span>
                <code>{template.file}</code>
              </Link>
            </li>
          ))}
        </ul>
      </section>,
    );
  const template = templateOf(templateId);
  const start = await builderStart(page, {
    mode: 'new',
    path: `${AUTOMATIONS_DIR}/${template.file}`,
    template: template.source,
  });
  if (start.kind !== 'ready')
    return shell(
      <p className={styles.banner} data-tone="bad">
        {start.kind === 'missing' ? 'This repository could not be read.' : start.message}
      </p>,
    );
  return shell(<AutomationBuilder {...start.props} />);
}
