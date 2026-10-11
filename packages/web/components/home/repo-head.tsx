import { IntentLink as Link } from '../shell/intent-link';
import type { Repository } from '../../src/people/repository';
import styles from './home.module.css';

export type RepoTab =
  | 'code'
  | 'files'
  | 'beans'
  | 'decisions'
  | 'checks'
  | 'engine'
  | 'changes'
  | 'history'
  | 'automations'
  | 'ask'
  | 'people'
  | 'settings';

/** Tabs that are questions: the generated explorer is the page for them. */
export const TAB_QUESTIONS: Readonly<Partial<Record<RepoTab, string>>> = {
  beans: "what's being worked on right now?",
  decisions: 'what did we decide?',
  checks: 'why did the sprout go red?',
};

const TABS: readonly { readonly tab: RepoTab; readonly name: string; readonly keys: string }[] = [
  { tab: 'code', name: 'Code', keys: 'g c' },
  { tab: 'files', name: 'Files', keys: 'g f' },
  { tab: 'beans', name: 'Beans', keys: 'g b' },
  { tab: 'decisions', name: 'Decisions', keys: 'g d' },
  { tab: 'checks', name: 'Checks', keys: 'g k' },
  { tab: 'engine', name: 'Engine', keys: 'g e' },
];

/**
 * A person's repository (`docs/claude-opus/20`): GitHub's shape with Gitstalk's words. Code
 * is the stalk's files, Changes the beans, History the stalk's commits with what is validated
 * versus only landed (verdicts from the repo-events index, `20` §7), Automations the
 * repository's Actions workflows and runs (`25` §5), Ask the generated explorer over the engine
 * (the race view's home).
 */
const REPOSITORY_TABS: readonly { readonly tab: RepoTab; readonly name: string }[] = [
  { tab: 'code', name: 'Code' },
  { tab: 'changes', name: 'Changes' },
  { tab: 'history', name: 'History' },
  { tab: 'automations', name: 'Automations' },
  { tab: 'ask', name: 'Ask' },
  { tab: 'people', name: 'People' },
  { tab: 'settings', name: 'Settings' },
];

export type RepoKind = 'race' | 'repository';

/**
 * The repository's header: owner and name once, then its views. Beans, Decisions and Checks
 * open the home explorer on their question; Engine is a race's canvas, for developers, and
 * Settings belongs to a persistent repository. `base` is `/runs/<run>` or `/<owner>/<repo>`.
 */
export function RepoHead(props: {
  readonly base: string;
  readonly repository: Repository;
  /** The open tab; `null` for the loading skeleton, which does not know it yet. */
  readonly current: RepoTab | null;
  readonly kind?: RepoKind;
  /** A persistent repository's visibility, shown beside its name. */
  readonly visibility?: 'public' | 'private' | 'internal';
  /** Where the owner's name links: their repositories, or the repository itself for a race. */
  readonly ownerHref?: string;
  /** A repository's open beans, counted on its Changes tab. */
  readonly openChanges?: number;
  /** Whether the viewer may open Settings (the owner); others do not see the tab. */
  readonly canAdminister?: boolean;
  /** A persistent repository its owner archived: read-only, said under the name. */
  readonly archived?: boolean;
}) {
  if (props.kind === 'repository') return <RepositoryHead {...props} />;
  return (
    <div className={styles.repohead}>
      <h1 className={styles.repotitle}>
        <Link href={props.ownerHref ?? props.base}>{props.repository.owner}</Link>
        <span>/</span>
        <Link href={props.base}>{props.repository.name}</Link>
        {props.visibility === undefined ? null : (
          <small className={styles.visibility}>{props.visibility}</small>
        )}
      </h1>
      <nav className={styles.tabs} aria-label="Repository views">
        {TABS.map((item) => (
          <Link
            key={item.tab}
            href={hrefOf(props.base, item.tab)}
            className={styles.tab}
            aria-current={props.current === item.tab ? 'page' : undefined}
            title={item.tab === 'engine' ? 'The engine’s race canvas, for developers' : undefined}
          >
            {item.name}
            <kbd className={styles.kh}>{item.keys}</kbd>
          </Link>
        ))}
      </nav>
    </div>
  );
}

function RepositoryHead(props: {
  readonly base: string;
  readonly repository: Repository;
  /** The open tab; `null` for the loading skeleton, which does not know it yet. */
  readonly current: RepoTab | null;
  readonly visibility?: 'public' | 'private' | 'internal';
  readonly ownerHref?: string;
  readonly openChanges?: number;
  readonly canAdminister?: boolean;
  readonly archived?: boolean;
}) {
  const tabs = REPOSITORY_TABS.filter(
    (item) => item.tab !== 'settings' || props.canAdminister !== false,
  );
  return (
    <div className={styles.repohead}>
      <h1 className={styles.repotitle}>
        <Link href={props.ownerHref ?? props.base}>{props.repository.owner}</Link>
        <span>/</span>
        <Link href={props.base}>{props.repository.name}</Link>
        {props.visibility === undefined ? null : (
          <small className={styles.visibility}>{props.visibility}</small>
        )}
        {props.archived === true ? <small className={styles.visibility}>archived</small> : null}
      </h1>
      {props.archived === true ? (
        <p className={styles.archivedNote} role="note">
          Archived by its owner: read-only. It still clones and fetches; pushes are refused.
        </p>
      ) : null}
      <nav className={styles.tabs} aria-label="Repository views">
        {tabs.map((item) => (
          <Link
            key={item.tab}
            href={repositoryTabHref(props.base, item.tab)}
            className={styles.tab}
            aria-current={props.current === item.tab ? 'page' : undefined}
          >
            {item.name}
            {item.tab === 'changes' && (props.openChanges ?? 0) > 0 ? (
              <span className={styles.tabCount} title="Beans in check, red or waiting">
                {props.openChanges}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** A repository tab's address. */
export function repositoryTabHref(base: string, tab: RepoTab): string {
  if (tab === 'code') return base;
  if (tab === 'automations') return `${base}/actions`;
  return `${base}/${tab}`;
}

/** Which tab a question belongs to, if it is one of the tabs' own questions. */
export function tabOf(q: string): RepoTab {
  const match = Object.entries(TAB_QUESTIONS).find(([, question]) => question === q);
  return match === undefined ? 'code' : (TABS.find((item) => item.tab === match[0])?.tab ?? 'code');
}

function hrefOf(base: string, tab: RepoTab): string {
  if (tab === 'files') return `${base}/files`;
  if (tab === 'engine') return `${base}/race`;
  if (tab === 'settings') return `${base}/settings`;
  if (tab === 'people') return `${base}/people`;
  const question = TAB_QUESTIONS[tab];
  return question === undefined ? base : `${base}?q=${encodeURIComponent(question)}`;
}
