'use client';

/**
 * The repository's header, drawn once by its layout (app/[owner]/[repo]/layout.tsx) and kept
 * mounted while the viewer moves between tabs and settings sections: a tab click swaps only the
 * page under it. The open tab comes from the address (`repoTabOf`); the Changes count is the
 * last one a page reported (`OpenChangesCount`), kept across tabs that do not count beans.
 */
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

import type { ViewerRole } from '../../src/repositories/registry-client';
import { repoTabOf, settingsTabHref } from '../../src/repo-pages/repo-tab-of';
import { RepoHead } from '../home/repo-head';

/** What the header shows of the repository, from the layout's access check. */
export type RepositoryFacts = {
  readonly base: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly archived: boolean;
  /** The viewer's role; null for someone reading a public repository (no Settings tab). */
  readonly role: ViewerRole | null;
};

const ReportOpenChanges = createContext<(count: number) => void>(() => undefined);

export function RepositoryFrame(props: {
  readonly facts: RepositoryFacts;
  readonly children: ReactNode;
}) {
  const { facts } = props;
  const [openChanges, setOpenChanges] = useState<number | null>(null);
  const pathname = usePathname();
  const query = useSearchParams();
  return (
    <ReportOpenChanges.Provider value={setOpenChanges}>
      <RepoHead
        base={facts.base}
        repository={{ owner: facts.owner, name: facts.name }}
        current={repoTabOf(facts.base, pathname, query)}
        kind="repository"
        visibility={facts.visibility}
        ownerHref={`/${facts.owner}`}
        canAdminister={facts.role !== null}
        archived={facts.archived}
        {...(openChanges === null ? {} : { openChanges })}
        {...(facts.role === null
          ? {}
          : {
              settingsHref: settingsTabHref(facts.base, {
                role: facts.role,
                isArchived: facts.archived,
              }),
            })}
      />
      {props.children}
    </ReportOpenChanges.Provider>
  );
}

/** Reports a page's count of open beans to the header above it. Renders nothing. */
export function OpenChangesCount(props: { readonly count: number }): null {
  const report = useContext(ReportOpenChanges);
  useEffect(() => report(props.count), [report, props.count]);
  return null;
}
