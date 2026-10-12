import { env } from 'cloudflare:workers';
import { IntentLink as Link } from '../shell/intent-link';

import { GreensChart } from '../race/greens-chart';
import { RunsTable } from './runs-table';
import styles from './runs.module.css';
import { listRuns } from '../../src/forge/sources';
import { formatMinutes, formatUsd } from '../../src/race/race-format';
import { racePair } from '../../src/recorded/race-pair';
import { ADMIN_RACE, adminRunPath } from '../../src/admin/admin-paths';

/** The k-th green the demo measures "most of the work" by (`research/race/kth_green.py`). */
const MOST_GREENS = 35;

function minutesOr(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? 'n/a' : formatMinutes(seconds);
}

/** The benchmark landing: the race in one chart, then recorded and live runs. */
export async function RunsLanding() {
  const [runs, pair] = await Promise.all([listRuns(env.GATEWAY), Promise.resolve(racePair())]);
  const { left: queue, right: beanstalk } = pair;
  const until = Math.max(queue.endedAt ?? 0, beanstalk.endedAt ?? 0);
  return (
    <main className={styles.page}>
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroText}>
          <h1 id="hero-title" className={styles.heroTitle}>
            Twelve agents, forty beans, one repo.
          </h1>
          <p className={styles.heroLede}>
            The same race twice on Cloudflare: a batched merge queue, then Gitstalk v2.5. Gitstalk
            had {MOST_GREENS} beans on the stalk in {minutesOr(beanstalk.greens[MOST_GREENS - 1])},
            the queue in {minutesOr(queue.greens[MOST_GREENS - 1])}; it was done in{' '}
            {minutesOr(beanstalk.wallSeconds)} against {minutesOr(queue.wallSeconds)}, for{' '}
            {formatUsd(beanstalk.costUsd)} against {formatUsd(queue.costUsd)} of agent spend.
          </p>
          <p className={styles.heroActions}>
            <Link href={ADMIN_RACE} className={styles.primary}>
              Watch the race
            </Link>
            <Link href={adminRunPath(beanstalk.run)} className={styles.secondary}>
              Explore the Gitstalk repository
            </Link>
          </p>
        </div>
        <div className={styles.heroChart}>
          <GreensChart
            title="Beans on the stalk"
            series={[
              {
                id: 'queue',
                label: queue.label,
                color: 'var(--series-queue)',
                greens: queue.greens,
                endedAt: queue.endedAt,
              },
              {
                id: 'beanstalk',
                label: beanstalk.label,
                color: 'var(--series-v2)',
                greens: beanstalk.greens,
                endedAt: beanstalk.endedAt,
              },
            ]}
            now={until}
            until={until}
            beans={beanstalk.beans}
            marks={[20, 30, 35]}
          />
        </div>
      </section>
      <RunsTable title="Recorded runs" runs={runs.recorded} empty="No recorded runs are bundled." />
      <RunsTable
        title="Live runs"
        runs={runs.live}
        empty={runs.liveError ?? 'The gateway has no runs yet. Start one with the race driver.'}
      />
    </main>
  );
}
