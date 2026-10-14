/**
 * The stalk's marks, small: a leaf (asymmetric rounded square) on the stalk or the sprout,
 * a bean for an open change, a hollow bean held for a person, a red leaf, a folded leaf for
 * parked, a seed at the root.
 * Colour says which; the shape says what.
 */
import styles from './repo-tabs.module.css';

export type GlyphKind = 'stalk' | 'sprout' | 'bean' | 'held' | 'red' | 'parked' | 'seed';

const LABELS: Readonly<Record<GlyphKind, string>> = {
  stalk: 'on the stalk',
  sprout: 'on the sprout, not validated yet',
  bean: 'open bean',
  held: 'held for a person’s approval',
  red: 'red',
  parked: 'parked',
  seed: 'first commit',
};

export function Glyph(props: { readonly kind: GlyphKind; readonly live?: boolean }) {
  return (
    <svg
      className={styles.glyph}
      data-kind={props.kind}
      data-live={props.live === true ? '' : undefined}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      role="img"
      aria-label={LABELS[props.kind]}
    >
      {shapeOf(props.kind)}
    </svg>
  );
}

function shapeOf(kind: GlyphKind) {
  switch (kind) {
    case 'bean':
      return (
        <ellipse cx="7" cy="7" rx="4.2" ry="5.6" transform="rotate(28 7 7)" fill="currentColor" />
      );
    case 'held':
      return (
        <ellipse
          cx="7"
          cy="7"
          rx="3.6"
          ry="5"
          transform="rotate(28 7 7)"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      );
    case 'seed':
      return (
        <path
          d="M7 2c3 2.5 4 5 2.6 8.2C8.7 12 5.3 12 4.4 10.2 3 7 4 4.5 7 2Z"
          fill="currentColor"
        />
      );
    case 'parked':
      return (
        <path
          d="M2 12c0-6 4-10 10-10-1 6-4 10-10 10Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      );
    case 'stalk':
    case 'sprout':
    case 'red':
      // A leaf: rounded on three corners, pointed on the fourth.
      return <path d="M2 12c0-6 4-10 10-10 0 6-4 10-10 10Z" fill="currentColor" />;
    default:
      return null;
  }
}
