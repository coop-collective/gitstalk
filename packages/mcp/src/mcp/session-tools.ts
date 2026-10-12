/**
 * Tools only a person's agent session has (OAuth or a personal token): who am I. The
 * repository tools (../repos/repo-tools.ts) carry the rest, `git_credentials` among them.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { repositoryAccess } from '../tools/repository-access';
import type { ToolScope } from '../tools/tool-context';
import { answer, failure } from './tool-result';

export const SESSION_TOOL_NAMES = ['whoami', 'repository_access'] as const;

export function registerSessionTools(server: McpServer, scope: ToolScope): void {
  const { session } = scope;
  if (session === undefined) return;
  server.registerTool(
    'whoami',
    {
      title: 'Who this session is',
      description:
        'The Gitstalk account this agent session acts for: handle, the client the person approved, the scopes granted (read, collaborate, write, secrets) and the run tools read when they name no repository.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      answer(async () => ({
        handle: session.handle,
        client: session.clientName,
        via: session.via,
        scopes: session.scopes,
        run: scope.own?.run ?? null,
        web: scope.webUrl,
      })),
  );
  server.registerTool(
    'repository_access',
    {
      title: 'Your access to a repository',
      description:
        "What this session's person may do with a repository (owner/name): their role (owner, maintain, write, read, or none on a public repository), and whether this session may read, push beans, run workflows (maintain role and write scope) and set secrets (maintain role and secrets scope). A repository they may not see answers as not found, like one that does not exist.",
      inputSchema: z.object({
        repository: z.string().trim().min(3).max(110).describe('owner/name, e.g. coop/greeter'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repository }) => {
      const access = { gateway: scope.gateway, session };
      const read = await repositoryAccess(access, repository, 'read');
      if (!read.ok) return failure(read.message);
      const write = await repositoryAccess(access, repository, 'write');
      const { owner, name, visibility, viewer_role: role } = read.repository;
      const maintains = role === 'owner' || role === 'maintain';
      return answer(async () => ({
        repository: `${owner.handle}/${name}`,
        visibility,
        role,
        scopes: session.scopes,
        may: {
          read: true,
          push_beans: write.ok,
          run_workflows: maintains && session.scopes.includes('write'),
          set_secrets: maintains && session.scopes.includes('secrets'),
          decide: false,
          settings: false,
        },
        why: write.ok ? null : write.message,
      }));
    },
  );
}
