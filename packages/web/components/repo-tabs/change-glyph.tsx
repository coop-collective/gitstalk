/**
 * A bean's mark by its state, for the client-rendered Changes lists. The same mapping as the
 * ref switcher's `glyphOfState`, kept here so client bundles do not pull the switcher (and the
 * id schemas its links import).
 */
import type { ChangeState } from '../../src/changes/changes';
import type { GlyphKind } from './glyph';
import { Glyph } from './glyph';

export function ChangeGlyph(props: { readonly state: ChangeState }) {
  return <Glyph kind={GLYPHS[props.state]} live={props.state === 'checking'} />;
}

const GLYPHS: Readonly<Record<ChangeState, GlyphKind>> = {
  validated: 'stalk',
  landed: 'sprout',
  red: 'red',
  conflict: 'red',
  'fell-off': 'red',
  parked: 'parked',
  checking: 'bean',
  waiting: 'bean',
};
