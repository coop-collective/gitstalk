/**
 * The repository tools of a person's agent session (`docs/claude-opus/23-mcp-repository-tools.md`).
 * Git stays the interface: an agent clones, commits and pushes `bean/<name>` with git. These
 * tools add what git cannot say or do: which repositories the person may use, a reserved bean
 * name with its intent, the verdict with the beans it collided with, a wait that is the twin
 * of `git push origin HEAD:refs/wait/any`, a backlog two agents cannot both claim from, and a short-lived git
 * credential for a machine whose git is not set up. Plain, task-shaped tools; no code mode.
 */
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { MAX_BEAN_WAIT_SECONDS } from '@gitstalk/shared-race/agent-repos';
import { BeanCommitInput } from '@gitstalk/shared-race/bean-commit';

import { sessionMayWrite } from '../mcp/scope-gate';
import { answer } from '../mcp/tool-result';
import type { ToolScope } from '../tools/tool-context';
import { gitCredentials } from './git-credentials';
import {
  beanWait,
  commitBean,
  openBean,
  repoList,
  taskClaim,
  taskList,
  taskRelease,
} from './repo-answers';

/** Every session. `repo_status` and `bean_status` serve run tokens too (`../mcp/server.ts`). */
export const REPO_READ_TOOL_NAMES = [
  'repo_list',
  'bean_wait',
  'task_list',
  'git_credentials',
] as const;
/** Sessions with the write scope (the write role is checked per call). */
export const REPO_WRITE_TOOL_NAMES = [
  'bean_open',
  'bean_commit',
  'task_claim',
  'task_release',
] as const;

const READS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Reserving a name or claiming a task again renews it: repeatable, never destructive. */
const RESERVES: ToolAnnotations = { ...READS, readOnlyHint: false };

const Repo = z.string().trim().min(3).max(110).describe('owner/name (repo_list shows yours)');
const BeanName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe('The bean name: its branch is bean/<name> (letters, digits, . _ -; up to 32)');
const TaskId = z.string().trim().min(1).max(64).describe('A task id from task_list');

/**
 * Registers the tools for an agent session, the writes only with the write scope; run tokens
 * get none of them.
 */
export function registerRepoTools(server: McpServer, scope: ToolScope): void {
  if (scope.session === undefined || scope.agents === undefined) return;
  registerRepositoryList(server, scope);
  registerBeanWait(server, scope);
  registerTaskList(server, scope);
  registerCredentials(server, scope);
  if (!sessionMayWrite(scope)) return;
  registerBeanOpen(server, scope);
  registerCommit(server, scope);
  registerTaskClaims(server, scope);
}

function registerRepositoryList(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'repo_list',
    {
      title: 'Your repositories',
      description:
        "The repositories you own on Gitstalk, with your access (write: you may push beans) and clone URL. Others' public repositories are named directly as owner/name.",
      inputSchema: z.object({}),
      annotations: READS,
    },
    async () => answer(() => repoList(scope)),
  );
}

function registerBeanOpen(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'bean_open',
    {
      title: 'Open a bean',
      description:
        "Before starting a change: reserve a bean name with its intent (one sentence on why), optionally for a backlog task (claims it). Returns the branch, the git commands to start from the sprout and to push, and the sprout's head. The reserved intent becomes the bean's intent when you push. Needs the write scope.",
      inputSchema: z.object({
        repo: Repo,
        bean: BeanName,
        intent: z.string().trim().min(1).max(4000).describe('What this change is for, and why'),
        task: TaskId.optional(),
      }),
      annotations: RESERVES,
    },
    async (input) => answer(() => openBean(scope, input)),
  );
}

function registerBeanWait(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'bean_wait',
    {
      title: 'Wait for a bean',
      description: `When you are out of other work after a git push: blocks until the bean's current check finishes (until: verdict, default) or it reaches the stalk (until: stalk), or timeout_s passes (default 300, at most ${MAX_BEAN_WAIT_SECONDS}); it wakes on the verdict, so never sleep-poll instead. Answers as bean_status with repo, with waited_s and timed_out. Plain git does the same for one or many beans: git push -o bean=<name> origin HEAD:refs/wait/any (or refs/wait/all).`,
      inputSchema: z.object({
        repo: Repo,
        bean: BeanName,
        until: z.enum(['verdict', 'stalk']).optional(),
        timeout_s: z.number().int().min(1).max(MAX_BEAN_WAIT_SECONDS).optional(),
      }),
      annotations: READS,
    },
    async (input) => answer(() => beanWait(scope, input)),
  );
}

/** A session's `repo` plus the contributor tool's input; `bean` may be given as `bean/<name>`. */
const SessionCommitInput = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && 'bean' in value && typeof value.bean === 'string'
      ? { ...value, bean: value.bean.trim().replace(/^bean\//, '') }
      : value,
  BeanCommitInput.safeExtend({ repo: Repo }),
);

/**
 * `bean_commit` for a session (doc 33). The same tool name as the contributor's (a run token
 * never has a session, so one server registers only one of the two).
 */
function registerCommit(server: McpServer, scope: ToolScope): void {
  if (scope.agents?.agentCommitBean === undefined || scope.own?.contributor !== undefined) return;
  server.registerTool(
    'bean_commit',
    {
      title: 'Commit files to a bean without a checkout',
      description:
        'Write or delete files on bean/<bean> as one commit the gateway builds, then submit it as a git push of that branch is (its pre-land check starts). No clone, no push: for small edits without a checkout (a doc, a revert, a conflict fix); with a checkout keep using git. expected_head is the branch head you read (null creates the branch from the sprout); if it moved you get kind "conflict" with current_head and nothing is written. changes: [{path, content} | {path, delete: true}], at most 64 paths and 192 KiB. Reuse idempotency_key only for an exact retry. Needs the write scope; protected paths need a person.',
      inputSchema: SessionCommitInput,
      annotations: RESERVES,
    },
    async (input) => answer(() => commitBean(scope, input)),
  );
}

function registerTaskList(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'task_list',
    {
      title: 'Backlog of a repository',
      description:
        "The repository's backlog (.gitstalk/backlog.md or BACKLOG.md on the sprout): each task's id, title, detail and state: open, claimed (by whom, until when), in_progress (whose bean) or done.",
      inputSchema: z.object({ repo: Repo }),
      annotations: READS,
    },
    async ({ repo }) => answer(() => taskList(scope, repo)),
  );
}

function registerTaskClaims(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'task_claim',
    {
      title: 'Claim a task',
      description:
        'Before working on a backlog task: claim it so no other agent takes it (two hours; claim again or bean_open with task to keep it; a pushed bean for the task holds it until it lands). Refused, with who holds it, when it is taken. Needs the write scope and the write role.',
      inputSchema: z.object({ repo: Repo, task: TaskId }),
      annotations: RESERVES,
    },
    async ({ repo, task }) => answer(() => taskClaim(scope, { repo, task })),
  );
  server.registerTool(
    'task_release',
    {
      title: 'Give a task back',
      description:
        'When you will not do a task you claimed (it turned out done, or you are stopping): drops your claim and the bean names you reserved for it, so another agent can take it. A bean you pushed for it still holds it. Needs the write scope and the write role.',
      inputSchema: z.object({ repo: Repo, task: TaskId }),
      annotations: RESERVES,
    },
    async ({ repo, task }) => answer(() => taskRelease(scope, { repo, task })),
  );
}

function registerCredentials(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'git_credentials',
    {
      title: 'Git credential for a repository',
      description:
        'Only when git on this machine is not connected to Gitstalk (a push or clone fails with Authentication failed): a short-lived HTTPS credential for one repository (at most an hour; read, plus push beans with the write scope), as git credential approve input. Pipe it to git; never print it, write it to a file, put it in a URL or commit it.',
      inputSchema: z.object({
        repo: Repo,
        ttl_minutes: z.number().int().min(5).max(60).optional(),
      }),
      annotations: { ...READS, readOnlyHint: false, idempotentHint: false },
    },
    async (input) => answer(() => gitCredentials(scope, input)),
  );
}
