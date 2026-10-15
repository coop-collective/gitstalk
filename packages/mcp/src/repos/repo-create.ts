/**
 * `repo_create` (`docs/claude-opus/20-repositories.md` §10): a new repository through the
 * gateway's one creation path, the web form's, so the name rules, the namespace rule (the
 * person's own, or an organization whose repository setting lets their role) and the audit are
 * decided there. Registered only for sessions with the `create` scope.
 */
import { z } from 'zod';

import type {
  CreatedRepository,
  RepoCreateRequest,
  RepoCreateRpc,
} from '@gitstalk/shared-race/repo-create';
import { REPO_CREATE_STARTS, REPO_CREATE_VISIBILITIES } from '@gitstalk/shared-race/repo-create';

import { ToolError } from '../mcp/tool-result';
import type { ToolScope } from '../tools/tool-context';
import { valueOf } from './agent-gateway';

/** The tool's input: the API's request, described for the model. */
export const RepoCreateInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .describe('The repository name: letters, digits, . _ - (starts with a letter or digit)'),
  owner: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('An organization handle; omit for your person’s own namespace'),
  visibility: z
    .enum(REPO_CREATE_VISIBILITIES)
    .optional()
    .describe('private (default) or public; ask your person before making it public'),
  start: z
    .enum(REPO_CREATE_STARTS)
    .optional()
    .describe('empty (default: a README until the first push) or a starter id'),
  description: z.string().trim().max(350).optional(),
});
export type RepoCreateInput = z.infer<typeof RepoCreateInput>;

export async function repoCreate(scope: ToolScope, input: RepoCreateInput): Promise<object> {
  const { session } = scope;
  if (session === undefined) throw new ToolError('repo_create needs a signed-in agent session');
  const rpc = asRepoCreate(scope.gateway);
  if (rpc === undefined) throw new ToolError('this Gitstalk cannot create repositories yet');
  // The gateway validates (422 with the rule broken), as it does for the web form and the API.
  const request: RepoCreateRequest = withoutUndefined(input);
  const created: CreatedRepository = valueOf(
    await rpc.createRepositoryAs(session.principal, request, 'repo_create'),
  );
  return created;
}

/** The binding as `RepoCreateRpc`, or undefined when the gateway predates it. */
function asRepoCreate(binding: object): RepoCreateRpc | undefined {
  return isRepoCreate(binding) ? binding : undefined;
}

function isRepoCreate(binding: object): binding is RepoCreateRpc {
  return typeof Reflect.get(binding, 'createRepositoryAs') === 'function';
}

function withoutUndefined(input: RepoCreateInput): RepoCreateRequest {
  const { name, owner, visibility, start, description } = input;
  return {
    name,
    ...(owner === undefined ? {} : { owner }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(start === undefined ? {} : { start }),
    ...(description === undefined ? {} : { description }),
  };
}
