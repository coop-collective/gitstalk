import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Approve on a bean's page: the server action checks the signed-in form, finds the repository
 * and calls the gateway's `approveBean` (the one RPC MCP `bean_approve` calls too) with the
 * person, the revision, the note and the web as the client. The gateway is a recording fake.
 */
const calls: unknown[][] = [];
let answer: unknown;
const gateway = {
  approveBean: (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(answer);
  },
};
let signedIn: unknown;

vi.mock('cloudflare:workers', () => ({ env: { GATEWAY: gateway } }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('./signed-in-form', () => ({
  signedInForm: () => Promise.resolve(signedIn),
  field: (data: FormData, name: string) => {
    const value = data.get(name);
    return typeof value === 'string' ? value : '';
  },
}));
vi.mock('../repositories/flows', () => ({
  lookupRepository: (owner: string, name: string) =>
    Promise.resolve(
      owner === 'acme' && name === 'shop'
        ? { kind: 'found', record: { id: 'r1', engine_id: 'e1', name, owner: { handle: owner } } }
        : { kind: 'not-found' },
    ),
}));

const { approveBeanAction } = await import('./approval-actions');

const HEAD = 'a'.repeat(40);
const APPROVAL = { by: 'dana', at: '2026-10-14T12:00:00.000Z', note: 'fine', client: 'web' };
const HOLD = {
  state: 'approved',
  revision: HEAD,
  classes: ['protected'],
  class: 'protected',
  by: 'policy',
  probability: null,
  reviewers: [],
  policy: { path: '.gitstalk/policy.yml', sha: null },
  approval: APPROVAL,
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const FIELDS = {
  owner: 'acme',
  name: 'shop',
  bean: 'login',
  revision: HEAD,
  note: ' fine ',
  idempotencyKey: 'k-1',
};

beforeEach(() => {
  calls.length = 0;
  signedIn = { session: { user: { id: 'u_dana', handle: 'dana' } } };
  answer = {
    ok: true,
    value: {
      bean: 'login',
      revision: HEAD,
      approval: APPROVAL,
      resubmitted: true,
      replayed: false,
      hold: HOLD,
    },
  };
});

describe('approving from the web', () => {
  it('calls approveBean for the signed-in person, with the revision, note and key', async () => {
    const state = await approveBeanAction({ kind: 'idle' }, form(FIELDS));
    expect(calls).toEqual([
      [
        'e1',
        'login',
        {
          approver: 'u_dana',
          revision: HEAD,
          note: 'fine',
          client: { kind: 'web' },
          idempotency_key: 'k-1',
        },
      ],
    ]);
    expect(state).toEqual({
      kind: 'approved',
      revision: HEAD,
      approval: APPROVAL,
      resubmitted: true,
    });
  });

  it("passes the gateway's refusal on in its words", async () => {
    answer = {
      ok: false,
      error: {
        code: 'forbidden',
        status: 403,
        message: 'approving a held bean needs the maintain role',
      },
    };
    expect(await approveBeanAction({ kind: 'idle' }, form(FIELDS))).toEqual({
      kind: 'refused',
      message: 'approving a held bean needs the maintain role',
    });
  });

  it('refuses a form that is not signed in, without calling the gateway', async () => {
    signedIn = { kind: 'refused', message: 'Sign in again.' };
    expect(await approveBeanAction({ kind: 'idle' }, form(FIELDS))).toEqual({
      kind: 'refused',
      message: 'Sign in again.',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a repository the person cannot see', async () => {
    const state = await approveBeanAction({ kind: 'idle' }, form({ ...FIELDS, name: 'secret' }));
    expect(state).toEqual({ kind: 'refused', message: 'No such repository.' });
    expect(calls).toEqual([]);
  });
});
