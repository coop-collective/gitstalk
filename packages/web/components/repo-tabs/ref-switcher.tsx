/**
 * Which line or bean the Code tab shows: the stalk (stable, the default), the sprout (landed,
 * validating) or any pushed bean's branch. A disclosure of plain links, so it works without
 * script and every choice is a URL.
 */
import { IntentLink as Link } from '../shell/intent-link';

import type { CodeView, RefChoice } from '../../src/code/tree';
import { codeHref, refLabel } from '../../src/code/tree';
import type { Change } from '../../src/changes/changes';
import type { GlyphKind } from './glyph';
import { Glyph } from './glyph';
import styles from './repo-tabs.module.css';

/** What the switcher shows of a pushed bean: only this is sent to the browser. */
export type RefBean = Pick<Change, 'bean' | 'state'>;

export function RefSwitcher(props: {
  readonly base: string;
  readonly view: CodeView;
  readonly path: string;
  readonly current: RefChoice;
  /** Pushed beans, open ones first. */
  readonly beans: readonly RefBean[];
}) {
  const href = (ref: RefChoice) => codeHref(props.base, props.view, props.path, ref);
  const isCurrent = (ref: RefChoice) => refLabel(ref) === refLabel(props.current);
  return (
    <details className={styles.refs}>
      <summary aria-label={`Showing ${refLabel(props.current)}; switch line or bean`}>
        <Glyph kind={glyphOfRef(props.current, props.beans)} />
        {refLabel(props.current)}
      </summary>
      <div className={styles.refMenu}>
        <h3>Lines</h3>
        <RefLink
          href={href({ kind: 'stalk' })}
          current={isCurrent({ kind: 'stalk' })}
          glyph="stalk"
          name="stalk"
          note="validated"
        />
        <RefLink
          href={href({ kind: 'sprout' })}
          current={isCurrent({ kind: 'sprout' })}
          glyph="sprout"
          name="sprout"
          note="landed, validating"
        />
        {props.beans.length === 0 ? null : <h3>Beans</h3>}
        {props.beans.map((bean) => {
          const ref: RefChoice = { kind: 'bean', name: bean.bean };
          return (
            <RefLink
              key={bean.bean}
              href={href(ref)}
              current={isCurrent(ref)}
              glyph={glyphOfState(bean.state)}
              name={`bean/${bean.bean}`}
              note={bean.state}
            />
          );
        })}
      </div>
    </details>
  );
}

function RefLink(props: {
  readonly href: string;
  readonly current: boolean;
  readonly glyph: GlyphKind;
  readonly name: string;
  readonly note: string;
}) {
  return (
    <Link href={props.href} aria-current={props.current ? 'true' : undefined}>
      <Glyph kind={props.glyph} />
      <span className={styles.refName}>{props.name}</span>
      <span className={styles.refNote}>{props.note}</span>
    </Link>
  );
}

export function glyphOfState(state: Change['state']): GlyphKind {
  switch (state) {
    case 'validated':
      return 'stalk';
    case 'landed':
      return 'sprout';
    case 'red':
    case 'conflict':
    case 'fell-off':
      return 'red';
    case 'parked':
      return 'parked';
    case 'held':
      return 'held';
    case 'checking':
    case 'waiting':
      return 'bean';
    default:
      return 'bean';
  }
}

function glyphOfRef(ref: RefChoice, beans: readonly RefBean[]): GlyphKind {
  if (ref.kind === 'commit') return 'stalk';
  if (ref.kind !== 'bean') return ref.kind;
  const bean = beans.find((candidate) => candidate.bean === ref.name);
  return bean === undefined ? 'bean' : glyphOfState(bean.state);
}
