'use server';

/**
 * Settings → Rules' writes from the browser: save the approval rules (a bean through the
 * automation builder's commit path, never a push to a line) and follow the bean. Each checks the
 * form (same origin, session, CSRF) and that the person can see the repository; the gateway
 * decides who may save (owner or maintainer) and checks the text with the engine's parser.
 */
import { env } from 'cloudflare:workers';
import { revalidatePath } from 'next/cache';

import { AutomationBase } from '@gitstalk/shared-race/automation-editor';

import type { BeanStatus } from '../automations/editor-client';
import { lookupRepository } from '../repositories/flows';
import { repositoryPath } from '../repositories/paths';
import { registryClient } from '../repositories/registry-client';
import type { RulesSaveResult } from '../rules/rules-client';
import { rulesClient } from '../rules/rules-client';
import { field, idempotencyOf, signedInForm } from './signed-in-form';

export type RulesSaveState =
  | { readonly kind: 'saved'; readonly result: RulesSaveResult }
  | { readonly kind: 'refused'; readonly message: string };

export type RulesBeanState =
  | { readonly kind: 'status'; readonly status: BeanStatus }
  | { readonly kind: 'refused'; readonly message: string };

/** Saves the rules' new text (`content`) on the version the page opened (`base`). */
export async function saveRulesAction(form: FormData): Promise<RulesSaveState> {
  const scope = await scopeOf(form);
  if ('kind' in scope) return scope;
  const base = AutomationBase.safeParse(parseJson(field(form, 'base')));
  if (!base.success) return refused('Reload the page: its starting version is missing.');
  const saved = await scope.client.save(scope.repoId, {
    base: base.data,
    content: field(form, 'content'),
    ...(field(form, 'message') === '' ? {} : { message: field(form, 'message') }),
    ...idempotencyOf(form),
  });
  return saved.ok ? { kind: 'saved', result: saved.value } : refused(saved.message);
}

/** Where a saved rules bean stands. */
export async function rulesBeanAction(form: FormData): Promise<RulesBeanState> {
  const scope = await scopeOf(form);
  if ('kind' in scope) return scope;
  const status = await scope.client.bean(scope.repoId, field(form, 'bean'));
  if (!status.ok) return refused(status.message);
  if (status.value.phase === 'landed' || status.value.phase === 'green')
    revalidatePath(`${scope.base}/settings/rules`);
  return { kind: 'status', status: status.value };
}

type Scope = {
  readonly client: NonNullable<ReturnType<typeof rulesClient>>;
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
  const client = rulesClient(env.GATEWAY, user.id);
  if (client === null) return refused('The rules editor is not running on this deployment.');
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
