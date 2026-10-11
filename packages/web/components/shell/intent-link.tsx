'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';
import { useState } from 'react';

/**
 * A link that prefetches only when the pointer, keyboard focus or a finger shows intent. A
 * plain Link prefetches every link in view; a page with a tab bar, a header and a dozen
 * repository links then fires a dozen RSC requests it mostly never uses. Once armed, the link
 * behaves as a default one, and the router keeps the prefetched payload for `staleTimes`.
 */
export function IntentLink(props: ComponentProps<typeof Link>) {
  const { onMouseEnter, onFocus, onTouchStart, prefetch, ...rest } = props;
  const [armed, setArmed] = useState(false);
  const arm = () => setArmed(true);
  return (
    <Link
      {...rest}
      prefetch={armed ? (prefetch ?? null) : false}
      onMouseEnter={(event) => {
        arm();
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        arm();
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        arm();
        onTouchStart?.(event);
      }}
    />
  );
}
