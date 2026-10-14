/**
 * Run reads plus optional contributor collaboration, and for a person's agent session the
 * repository tools. Capabilities follow the caller's token. A fresh server per request (the
 * stateless handler's contract). No code mode and no `execute` tool: the owner deferred code
 * mode as highly experimental; every tool is plain and task-shaped.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { LineRef } from '@gitstalk/shared-ask/ask/view-spec';

import { registerActionsTools } from '../actions/actions-tools';
import { repoStatus } from '../repos/repo-answers';
import { registerRepoTools } from '../repos/repo-tools';
import { askRepo } from '../tools/ask-repo';
import { beanStatus } from '../tools/bean-status';
import { MAX_READ_PATHS, repoRead } from '../tools/repo-read';
import type { ToolScope } from '../tools/tool-context';
import { workOverlaps } from '../tools/work-overlaps';
import { whyLines } from '../tools/why-lines';
import { withInbox } from '../tools/collaboration';
import { registerCollaboration } from './collaboration-tools';
import { registerSessionTools } from './session-tools';
import { answer } from './tool-result';

/** Every caller: run tokens (view and contributor) and sessions. All read-only. */
export const TOOL_NAMES = [
  'ask_repo',
  'work_overlaps',
  'why_lines',
  'bean_status',
  'repo_status',
  'repo_read',
] as const;

/** These tools only read; reads of the same run state answer the same. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const Bean = z
  .string()
  .min(1)
  .max(64)
  .describe('A bean id (t032), a bean name (add-total) or its branch (beans/t032, bean/add-total)');
const RepoPath = z.string().min(1).max(300);
/** Signed-in agent sessions name the repository; run tokens read their own run. */
const Repo = z
  .string()
  .max(110)
  .optional()
  .describe('owner/name of a repository you may use (repo_list); omit to read your run');

export function createServer(scope: ToolScope): McpServer {
  const server = new McpServer({ name: 'gitstalk', version: '0.3.0' });
  registerAsk(server, scope);
  registerWorkOverlaps(server, scope);
  registerWhyLines(server, scope);
  registerBeanStatus(server, scope);
  registerRepoStatus(server, scope);
  registerRepoRead(server, scope);
  if (scope.own !== null) registerCollaboration(server, scope.own);
  registerSessionTools(server, scope);
  registerRepoTools(server, scope);
  registerActionsTools(server, scope);
  return server;
}

function registerAsk(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'ask_repo',
    {
      title: 'Ask the repo',
      description:
        "Ask a question about a repository in plain words (what is in flight in billing? what tests cover checkout? show bean t032). Answers with the explorer's view as JSON: the view spec, resolved files, beans, decisions and a preview_url.",
      inputSchema: z.object({
        question: z.string().trim().min(1).max(300),
        ref: LineRef.optional().describe('sprout (staged line, default) or stalk (stable line)'),
        repo: Repo,
      }),
      annotations: { ...READ_ONLY, title: 'Ask the repo' },
    },
    async ({ question, ref, repo }) =>
      answer(async () => {
        const ctx = await scope.context(repo);
        return withInbox(ctx, () => askRepo(ctx, question, ref ?? null));
      }),
  );
}

function registerWorkOverlaps(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'work_overlaps',
    {
      title: 'Work overlapping these paths',
      description:
        'Before editing: the beans in flight, awaiting validation, or green in the last 15 minutes that change these files or folders, with title, intent, slot, status and files. Read their intents and fit your change to theirs.',
      inputSchema: z.object({ paths: z.array(RepoPath).min(1).max(50), repo: Repo }),
      annotations: { ...READ_ONLY, title: 'Work overlapping these paths' },
    },
    async ({ paths, repo }) =>
      answer(async () => {
        const ctx = await scope.context(repo);
        return withInbox(ctx, () => workOverlaps(ctx, paths));
      }),
  );
}

function registerWhyLines(server: McpServer, scope: ToolScope): void {
  const Line = z.number().int().min(1).max(10_000_000).optional();
  server.registerTool(
    'why_lines',
    {
      title: 'Why these lines',
      description:
        "Before changing code: which bean last changed each line range of a file, with the bean's title (its intent), landing commit and decision cards, plus the path's recent landings and reverts. Reverted beans give their lines back. Omit start and end for the whole file.",
      inputSchema: z.object({
        path: RepoPath,
        start: Line.describe('first line, 1-based'),
        end: Line.describe('last line, inclusive'),
        ref: LineRef.optional().describe('sprout (staged line, default) or stalk (stable line)'),
        repo: Repo,
      }),
      annotations: { ...READ_ONLY, title: 'Why these lines' },
    },
    async ({ path, start, end, ref, repo }) =>
      answer(async () => {
        const ctx = await scope.context(repo);
        return withInbox(ctx, () => whyLines(ctx, { path, start, end, ref }));
      }),
  );
}

function registerBeanStatus(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'bean_status',
    {
      title: 'Status of a bean',
      description:
        "Where a bean stands after it was submitted: in flight or checking, landed on the sprout awaiting validation, green on the stalk, red or in conflict (sent back), deciding, reverted or dropped; with the next step, recent steps, check counts and a preview_url. With repo: the pushed bean's verdict too (failing tests, the landed beans it collided with and their intent, the lines the pushes printed). checks: true adds the latest check's structured failures (file, test), flagging reds inherited from the sprout (not your fault) and protected acceptance tests (fix the code, never the test).",
      inputSchema: z.object({
        bean: Bean,
        repo: Repo,
        checks: z.boolean().optional().describe('true: the structured check failures too'),
      }),
      annotations: { ...READ_ONLY, title: 'Status of a bean' },
    },
    async (input) => answer(() => beanStatus(scope, input)),
  );
}

function registerRepoStatus(server: McpServer, scope: ToolScope): void {
  server.registerTool(
    'repo_status',
    {
      title: 'Status of a repository',
      description:
        'A repository (or, without repo, your run) at a glance: the stalk and sprout heads, the window of landings not yet validated, beans in flight (who, phase), beans sent back red or in conflict, recent red validations, open decision cards, workflow runs on the stalk head, and preview_urls to see the sprout and the stalk in the explorer.',
      inputSchema: z.object({ repo: Repo }),
      annotations: { ...READ_ONLY, title: 'Status of a repository' },
    },
    async ({ repo }) => answer(() => repoStatus(scope, repo)),
  );
}

function registerRepoRead(server: McpServer, scope: ToolScope): void {
  const Line = z.number().int().min(1).max(10_000_000).optional();
  server.registerTool(
    'repo_read',
    {
      title: 'Read code',
      description: `Read a repository without a checkout. path (a file) or paths (at most ${MAX_READ_PATHS}): their contents, optionally lines start..end; a long answer is cut and next_start says where to read on. path naming a directory, or a glob (src/**/*.ts; *.md matches at any depth): a tree listing. grep: matching lines with 2 lines of context, as rg --json messages (begin, context, match with submatches, end); a literal, or /regex/ for a regular expression (no backreferences or nested repeats); scoped by path, paths or glob; about 8k tokens a page, continue with cursor: next_cursor. ref: sprout (default), stalk, a bean branch or a commit.`,
      inputSchema: z.object({
        repo: Repo,
        ref: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe('sprout (default), stalk, beans/<id>, bean/<name> or a commit'),
        path: RepoPath.optional().describe('A file, or a directory to list or search under'),
        paths: z
          .array(RepoPath)
          .min(1)
          .max(MAX_READ_PATHS)
          .optional()
          .describe('Files to read, or to search under'),
        glob: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Files to list or search, as rg -g takes them'),
        grep: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Text to find; /regex/ for a regular expression'),
        start: Line.describe('first line, 1-based'),
        end: Line.describe('last line, inclusive'),
        cursor: z.string().max(200).optional().describe('next_cursor from the previous grep page'),
      }),
      annotations: { ...READ_ONLY, title: 'Read code' },
    },
    async ({ repo, ...input }) =>
      answer(async () => {
        const ctx = await scope.context(repo);
        return repoRead(ctx, input);
      }),
  );
}
