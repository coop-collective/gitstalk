/**
 * What the repository routes do, without the framework: create from the form, change
 * settings, delete with confirmation, and decide what `/<owner>/<repo>` shows. The server
 * actions and pages are thin wrappers, so these are what the route tests exercise.
 */
import { UpdateRepositoryInput } from '@gitstalk/shared-race/repos';

import type { User as SessionUser } from '../auth/user';
import { ReadGrant } from '../edge/read-grant';
import type { CreateFormResult, CreateValues } from './create-form';
import { DEFAULT_VALUES, readCreateForm } from './create-form';
import { isReservedOwner, repositoryPath } from './paths';
import type { RegistryClient, RepositoryRecord, ViewerRole } from './registry-client';
import { pathsAfterSave } from '../settings/redirects';

/** What a form action answers: go somewhere, or show the form again with messages. */
export type FormOutcome<State> =
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'show'; readonly state: State };

export type CreateState = {
  readonly values: CreateValues;
  readonly errors: Extract<CreateFormResult, { ok: false }>['errors'];
};

export const EMPTY_CREATE_STATE: CreateState = { values: DEFAULT_VALUES, errors: {} };

export async function createFlow(
  form: FormData,
  user: SessionUser,
  registry: RegistryClient,
): Promise<FormOutcome<CreateState>> {
  const read = readCreateForm(form);
  if (!read.ok) return { kind: 'show', state: { values: read.values, errors: read.errors } };
  const created = await registry.create({ id: user.id, handle: user.handle }, read.input);
  if (created.ok)
    return { kind: 'redirect', to: repositoryPath(created.value.owner.handle, created.value.name) };
  const values = valuesFrom(form);
  const errors =
    created.error.code === 'name_taken'
      ? {
          name:
            values.owner === '' || values.owner === user.handle
              ? `You already have a repository named ${values.name}.`
              : `${values.owner} already has a repository named ${values.name}.`,
        }
      : { form: sentence(created.error.message) };
  return { kind: 'show', state: { values, errors } };
}

export type SettingsState = {
  readonly saved: string | null;
  readonly error: string | null;
};

export const EMPTY_SETTINGS_STATE: SettingsState = { saved: null, error: null };

/** One settings section's save: general (name, description) or visibility. */
export async function updateFlow(
  form: FormData,
  user: SessionUser,
  registry: RegistryClient,
): Promise<FormOutcome<SettingsState>> {
  const repoId = text(form, 'repoId');
  const patch = UpdateRepositoryInput.safeParse({
    ...optional('name', text(form, 'name')),
    // An emptied description is a change; an absent one is not.
    ...(form.has('description') ? { description: text(form, 'description') } : {}),
    ...optional('visibility', text(form, 'visibility')),
    ...(form.has('website') ? { website: webAddress(text(form, 'website')) } : {}),
    ...(form.has('topics') ? { topics: topicList(text(form, 'topics')) } : {}),
  });
  if (!patch.success)
    return {
      kind: 'show',
      state: { saved: null, error: patch.error.issues[0]?.message ?? 'Check the form.' },
    };
  const updated = await registry.update(user.id, repoId, patch.data);
  if (!updated.ok) {
    const error =
      updated.error.code === 'name_taken'
        ? `You already have a repository named ${patch.data.name ?? ''}.`
        : sentence(updated.error.message);
    return { kind: 'show', state: { saved: null, error } };
  }
  const renamed = text(form, 'currentName') !== updated.value.name;
  if (renamed)
    return {
      kind: 'redirect',
      to: pathsAfterSave(repositoryPath(updated.value.owner.handle, updated.value.name)).renamed,
    };
  return { kind: 'show', state: { saved: 'Saved.', error: null } };
}

/** Deletes only when the person typed `<owner>/<name>` exactly. */
export async function deleteFlow(
  form: FormData,
  user: SessionUser,
  registry: RegistryClient,
): Promise<FormOutcome<SettingsState>> {
  const expected = text(form, 'fullName');
  if (text(form, 'confirm') !== expected)
    return {
      kind: 'show',
      state: { saved: null, error: `Type ${expected} to confirm the deletion.` },
    };
  const removed = await registry.remove(user.id, text(form, 'repoId'));
  if (!removed.ok)
    return { kind: 'show', state: { saved: null, error: sentence(removed.error.message) } };
  return { kind: 'redirect', to: '/?deleted=' + encodeURIComponent(expected) };
}

/** Archives or unarchives (`to` in the form), then shows Settings again with what changed. */
export async function archiveFlow(
  form: FormData,
  user: SessionUser,
  registry: RegistryClient,
): Promise<FormOutcome<SettingsState>> {
  const to = text(form, 'to');
  if (to !== 'archived' && to !== 'active')
    return { kind: 'show', state: { saved: null, error: 'Choose archive or unarchive.' } };
  const changed = await registry.archive(user.id, text(form, 'repoId'), to);
  if (!changed.ok)
    return { kind: 'show', state: { saved: null, error: sentence(changed.error.message) } };
  const { owner, name } = changed.value;
  return {
    kind: 'redirect',
    to: pathsAfterSave(repositoryPath(owner.handle, name))[
      to === 'archived' ? 'archived' : 'unarchived'
    ],
  };
}

/** What `/<owner>/<repo>` resolves to for this viewer. */
export type RepositoryLookup =
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'found';
      readonly record: RepositoryRecord;
      /** What the viewer is on it: owner, a collaborator role, or null (reading a public one). */
      readonly role: ViewerRole | null;
      readonly isOwner: boolean;
      /** Proof of this access check, for the edge caches (src/edge/read-grant.ts). */
      readonly grant: ReadGrant;
    };

export async function lookupRepository(
  owner: string,
  name: string,
  user: SessionUser | null,
  registry: RegistryClient,
): Promise<RepositoryLookup> {
  if (isReservedOwner(owner)) return { kind: 'not-found' };
  const found = await registry.get(owner, name, user?.id ?? null);
  if (!found.ok) return { kind: 'not-found' };
  const role = found.value.viewer_role;
  // The gateway answered the record for this viewer: they may read it, on this request.
  const grant = ReadGrant.afterAccessCheck(found.value);
  return { kind: 'found', record: found.value, role, isOwner: role === 'owner', grant };
}

/** Whether the engine has grown anything yet: no bean has started on an empty repository. */
export function hasGrown(events: readonly { readonly type: string }[]): boolean {
  return events.some((event) => event.type === 'task.start');
}

/** A repository has grown once a bean started or was pushed: its tabs replace the start page. */
export function hasGrownRepository(
  events: readonly { readonly type: string }[],
  pushed: readonly unknown[],
): boolean {
  return pushed.length > 0 || hasGrown(events);
}

function valuesFrom(form: FormData): CreateValues {
  return {
    owner: text(form, 'owner'),
    name: text(form, 'name'),
    description: text(form, 'description'),
    visibility: text(form, 'visibility') || DEFAULT_VALUES.visibility,
    start: text(form, 'start') || DEFAULT_VALUES.start,
    importUrl: text(form, 'importUrl'),
  };
}

function text(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === 'string' ? value.trim() : '';
}

/** A field only when it was given: an absent field is "unchanged". */
function optional(key: string, value: string | undefined): Readonly<Record<string, string>> {
  return value === undefined || value === '' ? {} : { [key]: value };
}

/** A typed address with https:// in front when the scheme was left off ('' stays ''). */
export function webAddress(typed: string): string {
  return typed === '' || /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
}

/** Topics as typed: separated by commas or spaces, "#" dropped. */
export function topicList(typed: string): string[] {
  return typed
    .split(/[\s,]+/)
    .map((topic) => topic.replace(/^#/, ''))
    .filter((topic) => topic !== '');
}

/** A gateway message as a sentence: capitalised, ending in a full stop. */
function sentence(message: string): string {
  const trimmed = message.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
