import { IntentLink as Link } from '../shell/intent-link';

import type { FileBadges, TreeModel } from '@gitstalk/shared-ask/ask/answer';
import { compareText } from '@gitstalk/shared-ask/repo/paths';
import styles from './explorer.module.css';
import type { ExplorerState } from './explorer-url';
import { explorerHref } from './explorer-url';

type Folder = {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, Folder>;
  readonly files: string[];
};

/**
 * The file tree: the whole repository, or only the answer's files and their folders. Each
 * file carries badges: changes in the range, beans in flight, red tests, decisions.
 */
export function FileTree(props: {
  readonly base: string;
  readonly state: ExplorerState;
  readonly tree: TreeModel;
  readonly selected: string | null;
}) {
  const root = buildFolders(props.tree.files);
  const matched = new Set(props.tree.matched);
  const openAll = props.tree.mode === 'filtered' || props.tree.files.length <= 40;
  return (
    <ul className={styles.tree} aria-label="Files">
      <FolderItems
        folder={root}
        context={{ ...props, matched, openAll, open: openFolders(props.tree, props.selected) }}
      />
    </ul>
  );
}

type Context = {
  readonly base: string;
  readonly state: ExplorerState;
  readonly tree: TreeModel;
  readonly selected: string | null;
  readonly matched: ReadonlySet<string>;
  readonly openAll: boolean;
  readonly open: ReadonlySet<string>;
};

function FolderItems({ folder, context }: { readonly folder: Folder; readonly context: Context }) {
  const folders = [...folder.folders.values()].toSorted((a, b) => compareText(a.name, b.name));
  const files = folder.files.toSorted(compareText);
  return (
    <>
      {folders.map((child) => (
        <li key={child.path}>
          <details className={styles.folder} open={context.openAll || context.open.has(child.path)}>
            <summary>{child.name}</summary>
            <ul>
              <FolderItems folder={child} context={context} />
            </ul>
          </details>
        </li>
      ))}
      {files.map((path) => (
        <li key={path}>
          <FileItem path={path} context={context} />
        </li>
      ))}
    </>
  );
}

function FileItem({ path, context }: { readonly path: string; readonly context: Context }) {
  const badges = context.tree.badges[path];
  const tone = toneOf(context, path);
  return (
    <Link
      href={explorerHref(context.base, context.state, { file: path, bean: null, view: null })}
      className={`${styles.fileLink} ${tone}`}
      aria-current={context.selected === path ? 'true' : undefined}
      title={path}
    >
      <span className={styles.fileName}>{path.slice(path.lastIndexOf('/') + 1)}</span>
      {badges === undefined ? null : <Badges badges={badges} />}
    </Link>
  );
}

/** In a full tree with an answer, matched files stand out and the rest step back. */
function toneOf(context: Context, path: string): string {
  if (context.tree.mode !== 'full' || context.matched.size === 0) return '';
  return (context.matched.has(path) ? styles.matched : styles.dim) ?? '';
}

function Badges({ badges }: { readonly badges: FileBadges }) {
  return (
    <span className={styles.badges}>
      {badges.changes > 0 ? (
        <span
          className={styles.badge}
          title={`${badges.changes} landings changed it in this range`}
        >
          <span className="visually-hidden">changed </span>+{badges.changes}
        </span>
      ) : null}
      {badges.inFlight > 0 ? (
        <span
          className={`${styles.badge} ${styles.badgeFlight}`}
          title={`${badges.inFlight} beans in flight touch it`}
        >
          <span aria-hidden="true">◆</span>
          <span className="visually-hidden">in flight </span>
          {badges.inFlight}
        </span>
      ) : null}
      {badges.red > 0 ? (
        <span
          className={`${styles.badge} ${styles.badgeRed}`}
          title="Failed a validation or a check in this range"
        >
          <span aria-hidden="true">✕</span>
          <span className="visually-hidden">failed a check</span>
        </span>
      ) : null}
      {badges.decisions > 0 ? (
        <span className={`${styles.badge} ${styles.badgeDecision}`} title="Part of a decision card">
          <span aria-hidden="true">?</span>
          <span className="visually-hidden">decision</span>
        </span>
      ) : null}
    </span>
  );
}

function buildFolders(paths: readonly string[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    const fileName = parts.pop();
    if (fileName === undefined) continue;
    const parent = parts.reduce((folder, part) => {
      const childPath = folder.path === '' ? part : `${folder.path}/${part}`;
      const existing = folder.folders.get(part);
      if (existing !== undefined) return existing;
      const created: Folder = { name: part, path: childPath, folders: new Map(), files: [] };
      folder.folders.set(part, created);
      return created;
    }, root);
    parent.files.push(path);
  }
  return root;
}

/** Folders to open in a big full tree: the top level, and those holding the selection or a match. */
function openFolders(tree: TreeModel, selected: string | null): ReadonlySet<string> {
  const open = new Set<string>(
    tree.files.flatMap((path) => (path.includes('/') ? [path.split('/')[0] ?? ''] : [])),
  );
  for (const path of [...tree.matched, ...(selected === null ? [] : [selected])]) {
    const parts = path.split('/').slice(0, -1);
    parts.forEach((_, index) => open.add(parts.slice(0, index + 1).join('/')));
  }
  return open;
}
