# <Title: what it does, in a few words>

Status: Proposed (YYYY-MM-DD) · Author: @handle, written with <harness and model, or "by hand"> · Roadmap: <item from ROADMAP.md, or "new"> · Pull request: #<number>

<One paragraph: what this adds or changes, for whom, and the source of the idea (a user request, an issue, a measurement, a design doc, prior art), with links.>

## Why

<The problem, with evidence. Who hits it, how often, what it costs them today. Link sources; label anything estimated. If it is a roadmap item, say what the roadmap's acceptance line asks for.>

## What people and agents see

<The behaviour from the outside, before any internals.>

| Where | What |
|---|---|
| Web (`/<owner>/<repo>/...`) | <screens, states, empty and error states> |
| MCP tool(s) | <tool names, inputs and results; every human action needs one (P1)> |
| git / CLI | <refs, push options, commands, if any> |
| Public docs | <which page in `packages/site/public/docs/` changes> |

## Design

<How it works. Name the package and the Cloudflare product for each part and say why that one: Worker, Durable Object (SQLite), D1, Queue, Workflow, R2, KV, Container, Sandbox, AI Gateway, Analytics Engine. A small diagram of what runs where helps.>

### Data

<New tables, Durable Object storage, R2 keys, migrations. Who writes, who reads.>

### Flow

<Step by step, in order, for the main path and the failure paths.>

## API

<Gateway RPC methods, HTTP routes, MCP tools, config files (with an example, as `docs/claude-opus/32-approval-rules.md` §1 does). Types live in a `shared-*` package.>

## Security and access

<Who may do this, and where that is decided (`mayUseEngine` in `packages/gateway/src/auth/git-credential.ts`). Tokens: agents never hold Artifacts tokens. Merging to the stalk is never an agent capability. Untrusted input (agent text, pushed files, webhooks) and how it is bounded.>

## Cost and limits

<Requests, storage and CPU per operation, against Cloudflare's limits (Artifacts: 1 GB per repository, 2,000 requests per 10 s per repository; Durable Object and Container limits). What it costs a person running their own deployment.>

## Alternatives considered

| Option | Why not |
|---|---|
| <option> | <reason> |

## Verification

<How we will know it works: tests with real Miniflare bindings (no mocks except external HTTP), a staging run, a measurement with a target. Acceptance criteria a reviewer can check.>

## Rollout

<Feature flag or setting, migration of existing data and repositories, deploy order across Workers, what breaks for existing users or self-hosted environments.>

## Not doing, and open questions

- <What is out of scope, and what a later proposal could take on.>
- <Questions for maintainers.>
