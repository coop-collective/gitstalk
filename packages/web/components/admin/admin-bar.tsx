'use client';

/**
 * The admin area's strip under the header: what this area is, then one link per page, the
 * current one marked. A strip rather than a side nav, so the race canvas keeps its width.
 */
import { IntentLink as Link } from '../shell/intent-link';
import { usePathname } from 'next/navigation';

import { ADMIN_DEMO_GATE, ADMIN_HOME, ADMIN_RACE, ADMIN_RUNS } from '../../src/admin/admin-paths';
import styles from './admin.module.css';

const LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: ADMIN_HOME, label: 'Overview' },
  { href: ADMIN_RUNS, label: 'Benchmark runs' },
  { href: ADMIN_RACE, label: 'Watch the race' },
  { href: ADMIN_DEMO_GATE, label: 'Demo gate' },
];

export function AdminBar() {
  const pathname = usePathname();
  return (
    <nav className={styles.bar} aria-label="Admin">
      <span className={styles.badge}>admin</span>
      <ul className={styles.links}>
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className={styles.link}
              aria-current={isCurrent(pathname, link.href) ? 'page' : undefined}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Overview only on its own path; the others also cover the pages under them. */
function isCurrent(pathname: string, href: string): boolean {
  if (href === ADMIN_HOME) return pathname === ADMIN_HOME;
  return pathname === href || pathname.startsWith(`${href}/`);
}
