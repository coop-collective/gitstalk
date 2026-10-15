/** The Code tab, laid out: the bar (with the Code button), the folder or file, the side column. */
import { groupCounts } from '../../src/changes/changes';
import type { CodeView, RefChoice } from '../../src/code/tree';
import type { CodePage } from '../../src/server/code-page';
import type { RepositoryTab } from '../../src/server/repository-tab';
import { BlobView } from './blob-view';
import type { CodeLocation } from './code-browser';
import { CodeAside, CodeBar, FolderView } from './code-browser';
import styles from './repo-tabs.module.css';
import { repoScopeOf } from './changes-tab';
import { RepositoryShell } from './repository-shell';
import { HeadWatcher } from './use-head-watcher';

export function CodeTab(props: {
  readonly tab: RepositoryTab;
  readonly data: CodePage;
  /** What is browsed: a line, a bean or a commit (`ref` is reserved for React). */
  readonly browsing: RefChoice;
  readonly path: string;
  readonly view: CodeView;
  readonly plain: boolean;
  readonly nowMs: number;
}) {
  const { tab, data } = props;
  const at = { base: tab.base, ref: props.browsing, path: props.path, sha: data.sha };
  const counts = groupCounts(data.changes);
  const beans = [...data.changes].toSorted(
    (a, b) => Number(b.group === 'open') - Number(a.group === 'open'),
  );
  return (
    <RepositoryShell page={tab} tab="code" openChanges={counts.open}>
      {tab.reads === null || !isLine(props.browsing) ? null : (
        <HeadWatcher
          scope={repoScopeOf(tab)}
          heads={{
            stalk: props.browsing.kind === 'stalk' ? data.sha : null,
            sprout: props.browsing.kind === 'sprout' ? data.sha : null,
          }}
          seq={data.seq}
        />
      )}
      <div className={props.view === 'blob' ? styles.single : styles.split}>
        <div>
          <CodeBar
            at={at}
            view={props.view}
            repoName={tab.record.name}
            beans={beans}
            menu={props.view === 'tree' ? { menu: data.menu, slug: slugOf(tab) } : null}
          />
          <CodeBody at={at} data={data} plain={props.plain} nowMs={props.nowMs} />
        </div>
        {props.view === 'blob' ? null : (
          <CodeAside
            base={tab.base}
            description={tab.record.description}
            changes={data.changes}
            onStalk={data.changes.filter((change) => change.state === 'validated').length}
          />
        )}
      </div>
    </RepositoryShell>
  );
}

/** Whether the page browses a line (which moves), not a bean or a commit. */
function isLine(ref: RefChoice): boolean {
  return ref.kind === 'stalk' || ref.kind === 'sprout';
}

function CodeBody(props: {
  readonly at: CodeLocation;
  readonly data: CodePage;
  readonly plain: boolean;
  readonly nowMs: number;
}) {
  const { body } = props.data;
  if (body.kind === 'missing')
    return (
      <section className={styles.box}>
        <p className={styles.empty}>{body.what}</p>
      </section>
    );
  if (body.kind === 'file') return <BlobView at={props.at} file={body.file} plain={props.plain} />;
  return (
    <FolderView
      at={props.at}
      entries={body.entries}
      head={props.data.head}
      nowMs={props.nowMs}
      readme={body.readme}
    />
  );
}

function slugOf(tab: RepositoryTab): string {
  return `${tab.record.owner.handle}/${tab.record.name}`;
}
