import type { CSSProperties } from 'react';

/** CSS custom properties as a `style` value (React's `CSSProperties` names no `--` properties). */
export function cssVars(vars: Readonly<Record<`--${string}`, string | number>>): CSSProperties {
  return vars;
}
