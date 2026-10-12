import { env } from 'cloudflare:workers';
import { IntentLink as Link } from '../../components/shell/intent-link';

import styles from '../../components/admin/admin.module.css';
import { requirePlatformAdmin } from '../../src/admin/admin-gate';
import { ADMIN_DEMO_GATE, ADMIN_RACE, ADMIN_RUNS } from '../../src/admin/admin-paths';
import type { PlatformCounts } from '../../src/admin/platform-stats';
import { platformCounts } from '../../src/admin/platform-stats';
import { log } from '../../src/log';

export const metadata = { title: 'Admin' };

const PAGES: readonly { readonly href: string; readonly title: string; readonly text: string }[] = [
  {
    href: ADMIN_RUNS,
    title: 'Benchmark runs',
    text: 'The race in one chart, then every recorded and live run with its repository and engine.',
  },
  {
    href: ADMIN_RACE,
    title: 'Watch the race',
    text: 'The recorded duel: the merge queue against Gitstalk v2.5, same tasks and seed.',
  },
  {
    href: ADMIN_DEMO_GATE,
    title: 'Demo gate',
    text: 'The DEMO_PASSWORD cookie that lets this browser answer decision cards on live runs.',
  },
];

/** The admin overview: a few platform counts, then the pages of the admin area. */
export default async function AdminHome() {
  const admin = await requirePlatformAdmin();
  const counts = await platformCounts(env.IDENTITY_DB).catch((error: unknown) => {
    log.error('admin counts failed', { error });
    return null;
  });
  return (
    <main className={styles.page}>
      <header>
        <h1 className={styles.title}>Admin</h1>
        <p className={styles.lede}>
          Signed in as @{admin.handle}, a platform admin (PLATFORM_ADMINS). Nothing here is shown to
          anyone else.
        </p>
      </header>
      <Counts counts={counts} />
      <ul className={styles.cards}>
        {PAGES.map((page) => (
          <li key={page.href}>
            <Link href={page.href} className={styles.card}>
              <span className={styles.cardTitle}>{page.title}</span>
              <span className={styles.cardText}>{page.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Counts({ counts }: { readonly counts: PlatformCounts | null }) {
  if (counts === null) return <p className={styles.note}>The platform counts did not load.</p>;
  return (
    <section aria-label="Platform counts">
      <dl className={styles.stats}>
        <Stat label="people" value={counts.people} />
        <Stat label="disabled accounts" value={counts.disabled} />
        <Stat label="organizations" value={counts.orgs} />
      </dl>
      <p className={styles.note}>
        Repositories are not counted here: the registry has no count call yet.
      </p>
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{value.toLocaleString('en-US')}</dd>
    </div>
  );
}
