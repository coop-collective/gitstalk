/**
 * The Code tab, laid out as an editor: the bar (ref switcher, path, Code button) over two
 * panes, the side pane on the left and the open file or folder on the right (code-workspace).
 * The side pane shows the beanstalk on a folder and the file tree on a file, with tabs for both.
 * A folder keeps the side column (About) beside its listing while there is room.
 *
 * The page reads one location; folders and files opened from it after that are drawn in the
 * browser (`code-opener.tsx`, `code-main.tsx`), so the bar and the main pane are client
 * components fed what the page read, and the side column and the stalk stay server-rendered.
 */
import { groupCounts } from '../../src/changes/changes';
import type { CodeView, RefChoice } from '../../src/code/tree';
import type { CodePage } from '../../src/server/code-page';
import type { RepositoryTab } from '../../src/server/repository-tab';
import { CodeAside } from './code-browser';
import { OpenCodeBar, OpenCodeMain, RenderedBody } from './code-main';
import { CodeStalk } from './code-stalk';
import { CodeWorkspace } from './code-workspace';
import treeStyles from './file-tree.module.css';
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
  const beans = [...data.changes]
    .toSorted((a, b) => Number(b.group === 'open') - Number(a.group === 'open'))
    .map(({ bean, state }) => ({ bean, state }));
  const aside = (
    <CodeAside
      base={tab.base}
      description={tab.record.description}
      changes={data.changes}
      onStalk={data.changes.filter((change) => change.state === 'validated').length}
    />
  );
  const rendered = (
    <RenderedBody
      at={at}
      body={data.body}
      head={data.head}
      plain={props.plain}
      nowMs={props.nowMs}
    />
  );
  const bar = (
    <OpenCodeBar
      at={at}
      view={props.view}
      repoName={tab.record.name}
      beans={beans}
      menu={{ menu: data.menu, slug: slugOf(tab) }}
    />
  );
  return (
    <RepositoryShell tab="code" openChanges={counts.open} wide={data.sha !== ''}>
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
      {data.sha === '' ? (
        // Nothing could be read (an unknown bean, an unreachable engine): no tree to show.
        <div className={styles.single}>
          {bar}
          {props.view === 'tree' ? (
            <div className={treeStyles.folderSplit}>
              <div>{rendered}</div>
              {aside}
            </div>
          ) : (
            rendered
          )}
        </div>
      ) : (
        <CodeWorkspace
          scope={repoScopeOf(tab)}
          at={{ ref: props.browsing, sha: data.sha, path: props.path, view: props.view }}
          plain={props.plain}
          folders={data.folders}
          bar={bar}
          stalk={<CodeStalk tab={tab} scope={repoScopeOf(tab)} />}
        >
          <OpenCodeMain
            base={tab.base}
            body={data.body}
            head={data.head}
            nowMs={props.nowMs}
            aside={aside}
          />
        </CodeWorkspace>
      )}
    </RepositoryShell>
  );
}

/** Whether the page browses a line (which moves), not a bean or a commit. */
function isLine(ref: RefChoice): boolean {
  return ref.kind === 'stalk' || ref.kind === 'sprout';
}

function slugOf(tab: RepositoryTab): string {
  return `${tab.record.owner.handle}/${tab.record.name}`;
}
