import { describe, expect, it } from 'vitest';

import { repoTabOf, settingsTabHref } from './repo-tab-of';

const BASE = '/coop/greeter';
const none = new URLSearchParams();

describe('the tab an address shows', () => {
  it.each([
    ['/coop/greeter', 'code'],
    ['/coop/greeter/', 'code'],
    ['/coop/greeter/tree/stalk/src', 'code'],
    ['/coop/greeter/blob/stalk/README.md', 'code'],
    ['/coop/greeter/changes', 'changes'],
    ['/coop/greeter/changes/fix-login', 'changes'],
    ['/coop/greeter/history', 'history'],
    ['/coop/greeter/actions', 'automations'],
    ['/coop/greeter/actions/runs/r1', 'automations'],
    ['/coop/greeter/automations/new', 'automations'],
    ['/coop/greeter/ask', 'ask'],
    ['/coop/greeter/people', 'people'],
    ['/coop/greeter/settings', 'settings'],
    ['/coop/greeter/settings/collaborators', 'settings'],
  ])('%s is %s', (pathname, tab) => {
    expect(repoTabOf(BASE, pathname, none)).toBe(tab);
  });

  it('is Ask on the root when the query is one of the Ask view’s', () => {
    expect(repoTabOf(BASE, BASE, new URLSearchParams('q=why'))).toBe('ask');
    expect(repoTabOf(BASE, BASE, new URLSearchParams('bean=fix-login'))).toBe('ask');
    expect(repoTabOf(BASE, BASE, new URLSearchParams('ref=sprout'))).toBe('code');
  });

  it('is none for another repository, a longer name or an unknown segment', () => {
    expect(repoTabOf(BASE, '/coop/greeter-two/changes', none)).toBeNull();
    expect(repoTabOf(BASE, '/coop', none)).toBeNull();
    expect(repoTabOf(BASE, '/coop/greeter/nowhere', none)).toBeNull();
  });

  it('compares percent-encoded addresses decoded', () => {
    expect(repoTabOf('/coop/caf%C3%A9', '/coop/café/history', none)).toBe('history');
  });
});

describe('where the Settings tab links', () => {
  it('the first section the viewer may open, so no redirect follows the click', () => {
    expect(settingsTabHref(BASE, { role: 'owner', isArchived: false })).toBe(
      '/coop/greeter/settings/general',
    );
    expect(settingsTabHref(BASE, { role: 'owner', isArchived: true })).toBe(
      '/coop/greeter/settings/branches',
    );
    expect(settingsTabHref(BASE, { role: 'write', isArchived: false })).toBe(
      '/coop/greeter/settings/branches',
    );
  });
});
