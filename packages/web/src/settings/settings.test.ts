import { describe, expect, it } from 'vitest';

import { readSwitchesForm, switchWrites, switchesOf } from '../actions/actions-switches';
import { pathsAfterSave } from './redirects';
import {
  ORG_ANCHORS,
  REPO_ANCHORS,
  anchorTarget,
  firstOrgSection,
  firstRepoSection,
  isRepoSection,
  orgSections,
  repoSections,
} from './sections';
import type { RepoSettingsFacts } from './sections';

const facts = (overrides: Partial<RepoSettingsFacts>): RepoSettingsFacts => ({
  role: 'owner',
  isArchived: false,
  hasActions: true,
  ...overrides,
});

const slugs = (sections: readonly { readonly slug: string }[]) => sections.map((s) => s.slug);

describe('repository settings pages', () => {
  it('gives the owner every section, General first and the Danger zone last', () => {
    expect(slugs(repoSections(facts({})))).toEqual([
      'general',
      'social-image',
      'visibility',
      'branches',
      'checks',
      'rules',
      'actions',
      'collaborators',
      'secrets',
      'deploy-tokens',
      'danger',
    ]);
    expect(firstRepoSection(facts({}))).toBe('general');
  });

  it('gives a maintainer the shared sections, Actions and deploy tokens, never the owner’s', () => {
    const sections = slugs(repoSections(facts({ role: 'maintain' })));
    expect(sections).toEqual([
      'branches',
      'checks',
      'rules',
      'actions',
      'secrets',
      'deploy-tokens',
    ]);
    expect(firstRepoSection(facts({ role: 'maintain' }))).toBe('branches');
  });

  it('gives write and read collaborators only what they may read', () => {
    for (const role of ['write', 'read'] as const)
      expect(slugs(repoSections(facts({ role })))).toEqual([
        'branches',
        'checks',
        'rules',
        'secrets',
      ]);
  });

  it('hides editing and deploy tokens while archived, and keeps the Danger zone to unarchive', () => {
    const sections = slugs(repoSections(facts({ isArchived: true })));
    expect(sections).not.toContain('general');
    expect(sections).not.toContain('deploy-tokens');
    expect(sections.at(-1)).toBe('danger');
    expect(firstRepoSection(facts({ isArchived: true }))).toBe('branches');
  });

  it('drops Secrets and variables where Actions do not run', () => {
    expect(slugs(repoSections(facts({ hasActions: false })))).not.toContain('secrets');
  });

  it('marks only the Danger zone as dangerous', () => {
    expect(
      repoSections(facts({}))
        .filter((s) => s.isDanger)
        .map((s) => s.slug),
    ).toEqual(['danger']);
  });

  it('knows its own slugs', () => {
    expect(isRepoSection('social-image')).toBe(true);
    expect(isRepoSection('nope')).toBe(false);
  });
});

describe('organization settings pages', () => {
  it('gives owners and admins every section', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(slugs(orgSections(role))).toEqual([
        'general',
        'members',
        'repository-defaults',
        'secrets',
        'audit-log',
        'danger',
      ]);
      expect(firstOrgSection(role)).toBe('general');
    }
  });

  it('gives members and viewers secrets (read) and the Danger zone (leave)', () => {
    for (const role of ['member', 'viewer'] as const) {
      expect(slugs(orgSections(role))).toEqual(['secrets', 'danger']);
      expect(firstOrgSection(role)).toBe('secrets');
    }
  });
});

describe('old anchors', () => {
  it('sends each old repository anchor to its page', () => {
    expect(anchorTarget(REPO_ANCHORS, '#social', 'general')).toBe('social-image');
    expect(anchorTarget(REPO_ANCHORS, '#actions', 'general')).toBe('secrets');
    expect(anchorTarget(REPO_ANCHORS, '#deploy-tokens', 'branches')).toBe('deploy-tokens');
    expect(anchorTarget(REPO_ANCHORS, '#archive', 'general')).toBe('danger');
    expect(anchorTarget(REPO_ANCHORS, '#transfer', 'general')).toBe('danger');
    expect(anchorTarget(REPO_ANCHORS, '#features', 'general')).toBe('actions');
  });

  it('stays put for an anchor of this page or an unknown one', () => {
    expect(anchorTarget(REPO_ANCHORS, '#general', 'general')).toBeNull();
    expect(anchorTarget(REPO_ANCHORS, '#nope', 'general')).toBeNull();
    expect(anchorTarget(REPO_ANCHORS, '#constructor', 'general')).toBeNull();
    expect(anchorTarget(REPO_ANCHORS, '', 'general')).toBeNull();
  });

  it('sends the old org icon anchor to General', () => {
    expect(anchorTarget(ORG_ANCHORS, '#icon', 'secrets')).toBe('general');
    expect(anchorTarget(ORG_ANCHORS, '#leave', 'general')).toBe('danger');
  });

  it('lands every old repository anchor on a section that exists', () => {
    for (const target of Object.values(REPO_ANCHORS)) expect(isRepoSection(target)).toBe(true);
  });
});

describe('redirects after a save', () => {
  it('lands renames, archives, transfers and uploads on their own pages', () => {
    const paths = pathsAfterSave('/ada/notes');
    expect(paths.renamed).toBe('/ada/notes/settings/general?saved=renamed');
    expect(paths.archived).toBe('/ada/notes/settings/danger?saved=archived');
    expect(paths.unarchived).toBe('/ada/notes/settings/danger?saved=unarchived');
    expect(paths.transferred).toBe('/ada/notes/settings/general?saved=transferred');
    expect(paths.socialImage('picture=saved')).toBe(
      '/ada/notes/settings/social-image?picture=saved',
    );
  });
});

describe('Actions switches', () => {
  it('reads the defaults when the repository sets nothing', () => {
    expect(switchesOf([])).toEqual({ depsCache: 'on', snapshotMax: '', npmAudit: 'off' });
  });

  it('reads the repository’s variables', () => {
    expect(
      switchesOf([
        { name: 'GITSTALK_DEPS_CACHE', value: 'OFF' },
        { name: 'GITSTALK_DEPS_SNAPSHOT_MAX', value: '2GiB' },
        { name: 'GITSTALK_NPM_AUDIT', value: 'true' },
      ]),
    ).toEqual({ depsCache: 'off', snapshotMax: '2GiB', npmAudit: 'on' });
  });

  it('reads the names from before the rename, the current one winning when both are set', () => {
    expect(
      switchesOf([
        { name: 'BEANSTALK_DEPS_CACHE', value: 'off' },
        { name: 'BEANSTALK_NPM_AUDIT', value: 'on' },
        { name: 'GITSTALK_NPM_AUDIT', value: 'off' },
      ]),
    ).toEqual({ depsCache: 'off', snapshotMax: '', npmAudit: 'off' });
  });

  it('sets a variable for each change from a default and removes the ones back at it', () => {
    const own = [{ name: 'GITSTALK_DEPS_CACHE' }, { name: 'GITSTALK_NPM_AUDIT' }];
    expect(switchWrites(own, { depsCache: 'on', snapshotMax: '500MB', npmAudit: 'off' })).toEqual({
      put: [{ name: 'GITSTALK_DEPS_SNAPSHOT_MAX', value: '500MB' }],
      remove: ['GITSTALK_DEPS_CACHE', 'GITSTALK_NPM_AUDIT'],
    });
    expect(switchWrites([], { depsCache: 'off', snapshotMax: '', npmAudit: 'on' })).toEqual({
      put: [
        { name: 'GITSTALK_DEPS_CACHE', value: 'off' },
        { name: 'GITSTALK_NPM_AUDIT', value: 'on' },
      ],
      remove: [],
    });
  });

  it('replaces a variable from before the rename with its current name on save', () => {
    const own = [{ name: 'BEANSTALK_DEPS_CACHE' }, { name: 'BEANSTALK_NPM_AUDIT' }];
    expect(switchWrites(own, { depsCache: 'off', snapshotMax: '', npmAudit: 'off' })).toEqual({
      put: [{ name: 'GITSTALK_DEPS_CACHE', value: 'off' }],
      remove: ['BEANSTALK_DEPS_CACHE', 'BEANSTALK_NPM_AUDIT'],
    });
  });

  it('reads the form: an unticked box is off, and a size must look like one', () => {
    const form = new FormData();
    form.set('snapshotMax', ' 2 GiB ');
    expect(readSwitchesForm(form)).toEqual({
      ok: true,
      value: { depsCache: 'off', snapshotMax: '2 GiB', npmAudit: 'off' },
    });
    form.set('snapshotMax', 'lots');
    expect(readSwitchesForm(form)).toEqual({ ok: false, message: 'A size such as 2GiB or 500MB.' });
  });
});
