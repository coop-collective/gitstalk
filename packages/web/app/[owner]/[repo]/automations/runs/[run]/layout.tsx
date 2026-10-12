import type { ReactNode } from 'react';

import type { RunParams } from '../../../../../../src/server/run-page';
import { runPage } from '../../../../../../src/server/run-page';

/**
 * The automation run's check, before anything streams: an unknown run is a 404 (see
 * `runPage`). The page reads the same answer and streams the job's log under its own Suspense
 * boundary.
 */
export default async function AutomationRunLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: RunParams;
}) {
  await runPage(params);
  return children;
}
