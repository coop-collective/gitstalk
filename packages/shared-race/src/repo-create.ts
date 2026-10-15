/**
 * Creating repositories without the web form (`docs/claude-opus/20-repositories.md` §10): the
 * MCP tool `repo_create`, `POST /api/repos` for scripts, and push-to-create. All three go
 * through the gateway's one creation path, the web form's, so names, namespaces, starters and
 * the audit are decided once. A caller needs the `create` scope; a new repository is private
 * and starts empty unless asked otherwise.
 */
import { z } from 'zod';

import type { AgentPrincipal } from './collaborators';
import type { CreateRepositoryInput, RepositoryRecord } from './repos';
import { MAX_REPO_DESCRIPTION, RepoName } from './repos';
import type { RpcResult } from './rpc';

/** How a repository may start from a tool or the API: a README, or the web form's starter. */
export const REPO_CREATE_STARTS = ['empty', 'typescript-starter'] as const;

/** Visibilities a tool or the API may choose; internal is an org setting made on the web. */
export const REPO_CREATE_VISIBILITIES = ['private', 'public'] as const;

/** Creations per person per hour, across the web, the tool, the API and pushes. */
export const MAX_CREATIONS_PER_HOUR = 20;

/**
 * How a session token minted by `git_credentials` for an address where no repository is yet
 * names it (`new:owner/name`): it opens that address only, to create it with a push.
 */
export const NEW_ADDRESS_PREFIX = 'new:';

/** Which client created a repository, as its audit line names it (`Via: <client>`). */
export type CreationVia = 'web' | 'repo_create' | 'api' | 'push';

/** What `repo_create` and `POST /api/repos` take. */
export const RepoCreateRequest = z.object({
  name: RepoName,
  /** An organization's handle, or absent (or the person's own handle) for a personal one. */
  owner: z
    .string()
    .trim()
    .transform((handle) => handle.replace(/^@/, ''))
    .pipe(z.string().max(39))
    .optional(),
  visibility: z.enum(REPO_CREATE_VISIBILITIES).default('private'),
  start: z.enum(REPO_CREATE_STARTS).default('empty'),
  description: z.string().trim().max(MAX_REPO_DESCRIPTION).default(''),
});
export type RepoCreateRequest = z.input<typeof RepoCreateRequest>;

/** The answer of `repo_create` and of `POST /api/repos` (201). */
export type CreatedRepository = {
  /** `owner/name`. */
  readonly full_name: string;
  /** `https://<web>/<owner>/<name>.git`: git is served by the web host. */
  readonly clone_url: string;
  readonly web_url: string;
  /** The stalk's first commit (the README seed of an empty start, until the first push). */
  readonly stalk: string | null;
  readonly visibility: 'public' | 'private' | 'internal';
  /** What to do next, as one plain sentence with the commands in it. */
  readonly next: string;
};

/** The gateway RPC behind `repo_create` and `POST /api/repos`. */
export type RepoCreateRpc = {
  /**
   * Creates a repository for a person's agent session or token. Refuses without `create`
   * (403 `insufficient_scope`), outside a namespace the person may create in (403
   * `forbidden`), an invalid request (422 `invalid_request`), a taken name (409 `exists`) and
   * more than `MAX_CREATIONS_PER_HOUR` creations in an hour (429 `rate_limited`).
   */
  createRepositoryAs(
    principal: AgentPrincipal,
    request: RepoCreateRequest,
    via: 'repo_create' | 'api',
  ): Promise<RpcResult<CreatedRepository>>;
};

/** The web form's input for a tool or API request. */
export function createInputOf(request: z.output<typeof RepoCreateRequest>): CreateRepositoryInput {
  return {
    ...(request.owner === undefined ? {} : { owner: request.owner }),
    name: request.name,
    description: request.description,
    visibility: request.visibility,
    start:
      request.start === 'empty'
        ? { kind: 'empty' }
        : { kind: 'template', template: 'typescript-starter' },
  };
}

/** What a new repository's creator is told: where it is and how to push a first bean. */
export function createdRepository(
  record: Pick<RepositoryRecord, 'owner' | 'name' | 'visibility' | 'origin'>,
  input: { readonly stalk: string | null; readonly webUrl: string },
): CreatedRepository {
  const fullName = `${record.owner.handle}/${record.name}`;
  const web = input.webUrl.replace(/\/+$/, '');
  const cloneUrl = `${web}/${fullName}.git`;
  return {
    full_name: fullName,
    clone_url: cloneUrl,
    web_url: `${web}/${fullName}`,
    stalk: input.stalk,
    visibility: record.visibility,
    next: nextStep(cloneUrl, record.origin.kind === 'empty'),
  };
}

function nextStep(cloneUrl: string, isEmpty: boolean): string {
  if (!isEmpty)
    return `git clone ${cloneUrl}, then git switch -c bean/start origin/sprout, change and commit, and git push origin bean/start: its pre-land check runs the starter's tests; follow the remote: lines.`;
  return `In your project run git remote add origin ${cloneUrl} (or git clone ${cloneUrl}), commit, then push the work as a bean: git push origin HEAD:refs/heads/bean/start. The first push into this empty repository becomes its stalk, history and all; push later changes as new beans from origin/sprout.`;
}
