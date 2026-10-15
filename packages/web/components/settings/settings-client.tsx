'use client';

/**
 * The bits of the settings pages that need the browser: the section nav (marking the current
 * section from the address, so a layout can keep it mounted across sections, and keeping it in
 * view in the phone's sideways strip), and moving an old one-page anchor (`#social`,
 * `#secrets`) to its own page. All progressive: without script the pages work as plain links.
 */
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { anchorTarget } from '../../src/settings/sections';
import { IntentLink as Link } from '../shell/intent-link';
import type { SettingsNavGroup, SettingsNavItem } from './settings-shell';
import styles from './settings-shell.module.css';

/**
 * The section links, grouped. A link is current when its page said so (`isCurrent`) or it is
 * the address shown; on narrow screens the current link is scrolled into the strip's middle.
 */
export function SettingsNav(props: { readonly groups: readonly SettingsNavGroup[] }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = ref.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (strip === null || current === null || current === undefined) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const stripBox = strip.getBoundingClientRect();
    const currentBox = current.getBoundingClientRect();
    strip.scrollLeft +=
      currentBox.left - stripBox.left - (strip.clientWidth - currentBox.width) / 2;
  }, [pathname]);
  return (
    <div ref={ref} className={styles.nav}>
      {props.groups.map((group) => (
        <div key={group.title} className={styles.group}>
          <span className={styles.groupTitle}>{group.title}</span>
          {group.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${item.isDanger === true ? styles.linkDanger : ''}`}
              aria-current={currentOf(item, pathname)}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Page links say "page"; anchors on one page say "true" (the section in view). */
function currentOf(item: SettingsNavItem, pathname: string): 'page' | 'true' | undefined {
  if (item.href.startsWith('#')) return item.isCurrent === true ? 'true' : undefined;
  return item.isCurrent === true || item.href === pathname ? 'page' : undefined;
}

/**
 * When the URL's anchor names a section of the old one-page settings that now has its own
 * page, replaces the location with that page (keeping the query and the anchor).
 */
export function LegacyAnchor(props: {
  readonly anchors: Readonly<Record<string, string>>;
  readonly current: string;
  /** The settings base: `/<owner>/<repo>/settings` or `/orgs/<org>/settings`. */
  readonly base: string;
  /** The sections this viewer may open; others stay put. */
  readonly allowed: readonly string[];
}) {
  const { anchors, current, base, allowed } = props;
  useEffect(() => {
    const target = anchorTarget(anchors, window.location.hash, current);
    if (target === null || !allowed.includes(target)) return;
    window.location.replace(`${base}/${target}${window.location.search}${window.location.hash}`);
  }, [anchors, current, base, allowed]);
  return null;
}
