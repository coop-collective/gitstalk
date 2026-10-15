/**
 * Tools only a person's agent session has (OAuth or a personal token): who am I, and what may
 * I do in a repository. The repository tools (../repos/repo-tools.ts) carry the rest,
 * `git_credentials` among them.
 */
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { repositoryAccess } from '../tools/repository-access';
import type { AgentSessionContext, ToolScope } from '../tools/tool-context';
import { answer, failure } from './tool-result';

export const SESSION_TOOL_NAMES = ['whoami'] as const;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerSessionTools(server: McpServer, scope: ToolScope): void {
  const { session } = scope;
  if (session === undefined) return;
  server.registerTool(
    'whoami',
    {
      title: 'Who this session is',
      description:
        "The Gitstalk account this agent session acts for: handle, the client the person approved, the scopes granted (read, collaborate, write, secrets, create: create repositories with repo_create) and the run tools read when they name no repository. With repo (owner/name): also the person's role there (owner, maintain, write, read, or none on a public repository) and whether this session may read, push beans, run workflows (maintain role and write scope) and set secrets (maintain role and secrets scope). A repository they may not see answers as not found, like one that does not exist.",
      inputSchema: z.object({
        repo: z
          .string()
          .trim()
          .min(3)
          .max(110)
          .optional()
          .describe('owner/name, e.g. coop/greeter: adds your access there'),
      }),
      annotations: READ_ONLY,
    },
    async ({ repo }) => {
      const who = {
        handle: session.handle,
        client: session.clientName,
        via: session.via,
        scopes: session.scopes,
        run: scope.own?.run ?? null,
        web: scope.webUrl,
      };
      if (repo === undefined) return answer(async () => who);
      const access = await accessTo(scope, session, repo);
      return access.ok
        ? answer(async () => ({ ...who, ...access.value }))
        : failure(access.message);
    },
  );
}

type Access =
  | { readonly ok: true; readonly value: object }
  | { readonly ok: false; readonly message: string };

/** What the session's person may do with `repo`: role, then each capability. */
async function accessTo(
  scope: ToolScope,
  session: AgentSessionContext,
  repo: string,
): Promise<Access> {
  const gate = { gateway: scope.gateway, session };
  const read = await repositoryAccess(gate, repo, 'read');
  if (!read.ok) return { ok: false, message: read.message };
  const write = await repositoryAccess(gate, repo, 'write');
  const { owner, name, visibility, viewer_role: role } = read.repository;
  const maintains = role === 'owner' || role === 'maintain';
  return {
    ok: true,
    value: {
      repository: `${owner.handle}/${name}`,
      visibility,
      role,
      may: {
        read: true,
        push_beans: write.ok,
        run_workflows: maintains && session.scopes.includes('write'),
        set_secrets: maintains && session.scopes.includes('secrets'),
        decide: false,
        settings: false,
      },
      why: write.ok ? null : write.message,
    },
  };
}
