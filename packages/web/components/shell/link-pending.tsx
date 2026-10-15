'use client';

/**
 * Marks the enclosing link while the page it opens is on its way (`useLinkStatus`), so a click
 * that keeps the current page on screen still answers at once. Renders only while pending.
 */
import { useLinkStatus } from 'next/link';

import styles from './link-pending.module.css';

export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className={styles.mark} aria-hidden="true" /> : null;
}
