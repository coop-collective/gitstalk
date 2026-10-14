'use server';

/**
 * The automation builder's writes and reads from the browser (doc 25 §7.13): save or delete a
 * file (a bean, never a push to a line), follow the bean, and run a draft once. Each checks the
 * form (same origin, session, CSRF) and that the person can see the repository named by `owner`
 * and `name`; the gateway then decides who may do what (write to save, maintain for a
 * protected file or a test run) and says why not.
 */
import { env } from 'cloudflare:workers';
import { revalidatePath } from 'next/cache';

import { AutomationBase } from '@gitstalk/shared-race/automation-editor';

import type { BeanStatus, SaveResult } from '../automations/editor-client';
import { editorClient } from '../automations/editor-client';
import { lookupRepository } from '../repositories/flows';
import { repositoryPath } from '../repositories/paths';
import { registryClient } from '../repositories/registry-client';
import { field, idempotencyOf, signedInForm } from './signed-in-form';

export type SaveState =
  | { readonly kind: 'saved'; readonly result: SaveResult }
  | { readonly kind: 'refused'; readonly message: string };

export type BeanState =
  | { readonly kind: 'status'; readonly status: BeanStatus }
  | { readonly kind: 'refused'; readonly message: string };

export type TestRunState =
  | { readonly kind: 'started'; readonly href: string }
  | { readonly kind: 'refused'; readonly message: string };

/** Saves the draft (`content`), or deletes the file (`mode=delete`), as a bean. */
export async function saveAutomationAction(form: FormData): Promise<SaveState> {
  const scope = await scopeOf(form);
  if ('kind' in scope) return scope;
  const base = AutomationBase.safeParse(parseJson(field(form, 'base')));
  if (!base.success) return refused('Reload the editor: its starting version is missing.');
  const saved = await scope.client.save(scope.repoId, {
    path: field(form, 'path'),
    base: base.data,
    content: field(form, 'mode') === 'delete' ? null : field(form, 'content'),
    ...(field(form, 'message') === '' ? {} : { message: field(form, 'message') }),
    ...idempotencyOf(form),
  });
  if (!saved.ok) return refused(saved.message);
  // No revalidation here: nothing changes on the stalk until the bean lands (the bean's status
  // revalidates then), and a revalidating action re-renders the builder page before it answers.
  return { kind: 'saved', result: saved.value };
}

/** Where a saved bean stands. */
export async function automationBeanAction(form: FormData): Promise<BeanState> {
  const scope = await scopeOf(form);
  if ('kind' in scope) return scope;
  const status = await scope.client.bean(scope.repoId, field(form, 'bean'));
  if (!status.ok) return refused(status.message);
  if (status.value.phase === 'landed' || status.value.phase === 'green')
    revalidatePath(`${scope.base}/automations`);
  return { kind: 'status', status: status.value };
}

/** Runs the draft once by hand without saving it (maintain or owner). */
export async function testAutomationAction(form: FormData): Promise<TestRunState> {
  const scope = await scopeOf(form);
  if ('kind' in scope) return scope;
  const started = await scope.client.testRun(scope.repoId, {
    path: field(form, 'path'),
    content: field(form, 'content'),
  });
  if (!started.ok) return refused(started.message);
  return {
    kind: 'started',
    href: `${scope.base}/automations/runs/${encodeURIComponent(started.value.runId)}`,
  };
}

type Scope = {
  readonly client: NonNullable<ReturnType<typeof editorClient>>;
  readonly repoId: string;
  readonly base: string;
};

async function scopeOf(
  form: FormData,
): Promise<Scope | { readonly kind: 'refused'; readonly message: string }> {
  const checked = await signedInForm(form);
  if ('kind' in checked) return checked;
  const user = checked.session.user;
  const found = await lookupRepository(
    field(form, 'owner'),
    field(form, 'name'),
    user,
    registryClient(env.GATEWAY),
  );
  if (found.kind === 'not-found') return refused('No such repository.');
  const client = editorClient(env.GATEWAY, user.id);
  if (client === null) return refused('The automation builder is not running on this deployment.');
  return {
    client,
    repoId: found.record.id,
    base: repositoryPath(found.record.owner.handle, found.record.name),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function refused(message: string): { readonly kind: 'refused'; readonly message: string } {
  return { kind: 'refused', message };
}
