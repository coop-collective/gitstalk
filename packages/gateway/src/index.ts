import { WorkerEntrypoint } from 'cloudflare:workers';

import { withHsts } from '@gitstalk/shared-identity/transport-security';
import type { EngineFeed, EngineFeedRpc } from '@gitstalk/shared-race/engine-feed';
import type {
  BeanContext,
  BeanContextInput,
  BeanDiscoverInput,
  BeanDiscoverPage,
  BeanInboxAckInput,
  BeanInboxAckResult,
  BeanInboxPage,
  BeanInboxReadInput,
  BeanPeerSummary,
  BeanThreadPostInput,
  BeanThreadPostResult,
  BeanUpdateInput,
  BeanUpdateResult,
} from '@gitstalk/shared-race/collaboration';
import type { BeanCommitInput, BeanCommitResult } from '@gitstalk/shared-race/bean-commit';

import type {
  BeanDetail,
  BeanStream,
  BeanStreamSummary,
  BeanSummary,
  DecisionRecord,
  GatewayRpc,
  GitToken,
  McpTokenClaims,
  OpenRepoEngineInput,
  PushedBeanStatus,
  RepoDiff,
  RepoFile,
  RepoGrep,
  RepoLog,
  RepoEngineOpened,
  RepoEngineRpc,
  RepoTree,
  RpcResult,
  RunEventsPage,
  RunListItem,
  RunView,
  TestCoverage,
  ViewToken,
  ViewTokenClaims,
} from '@gitstalk/shared-race/rpc';
import type { RouteReceipt } from '@gitstalk/shared-race/approval-policy';
import type {
  RulesEditorRpc,
  RulesSource,
  SaveRulesInput,
} from '@gitstalk/shared-race/rules-editor';
import type { ApprovalPolicyView } from '@gitstalk/shared-race/policy-file';

import type {
  CreateRepositoryInput,
  RepoOwner,
  RepositoriesRpc,
  RepositoryActivity,
  RepositoryListing,
  RepositoryFiles,
  RepositoryRecord,
  UpdateRepositoryInput,
  Viewer,
} from '@gitstalk/shared-race/repos';
import type {
  CreateDeployTokenInput,
  DeployTokenActor,
  DeployTokenSummary,
  DeployTokensRpc,
  IssuedDeployToken,
} from '@gitstalk/shared-race/deploy-tokens';
import type {
  AgentPrincipal,
  Collaborator,
  CollaboratorsRpc,
  Invitation,
  InviteInput,
  RepoRole,
  RepositoryAction,
  RepositoryForViewer,
  RepositoryPeople,
} from '@gitstalk/shared-race/collaborators';

import type {
  AgentBean,
  AgentReposRpc,
  AgentRepository,
  Backlog,
  BeanOpenInput,
  BeanOpened,
  BeanWaitUntil,
  BeanWaited,
  TaskClaimed,
  AgentAutomations,
} from '@gitstalk/shared-race/agent-repos';

import type {
  AgentActionsEntries,
  AgentActionsRpc,
  AgentAutomation,
  AgentAutomationStarted,
  AgentDispatchInput,
  AgentEntryDeleted,
  AgentEntryRef,
  AgentEntrySaved,
  AgentJobLog,
  AgentJobLogInput,
  AgentPutSecretInput,
  AgentPutVariableInput,
  AgentRun,
  AgentRunFilter,
  AgentRunPage,
  AgentRunSummary,
  AgentRunWaited,
  AgentWaitRunInput,
  AgentWorkflows,
} from '@gitstalk/shared-race/agent-actions';

import type {
  RepoIndexRpc,
  RepositoryGrowth,
  RepositoryStalk,
} from '@gitstalk/shared-race/repo-events';

import type {
  DerivedRpc,
  PathHistory,
  PathHistoryInput,
  WhyLines,
  WhyLinesInput,
} from '@gitstalk/shared-race/derived';

import type { AccountsRpc } from '@gitstalk/shared-race/accounts';
import type {
  AutomationBeanStatus,
  AutomationEditorRpc,
  AutomationSource,
  SaveAutomationInput,
  SaveAutomationResult,
  TestAutomationInput,
} from '@gitstalk/shared-race/automation-editor';

import { repositoryStorage } from './adapters/repository-storage';
import { accountsRpc } from './repos/accounts-rpc';
import { automationEditorRpc } from './automations/editor-rpc';
import { rulesEditorRpc } from './approval/rules-editor-rpc';
import { agentActionsRpc } from './agent/agent-actions-rpc';
import { agentReposRpc } from './agent/agent-repos-rpc';
import { consumeRepoEvents } from './repo-events/consumer';
import { repoIndexRpc } from './repo-events/index-rpc';
import type { DerivedFeed } from './repo-events/consumer';
import { derivedRpc } from './derive/derived-rpc';
import { sshKeyStore } from './auth/ssh-keys';
import type { SshDeps, SshKeyAnswer } from './ssh/ssh-git';
import { lookupSshKey, serveSshGit } from './ssh/ssh-git';
import { createApp } from './app';
import { createLogger } from './log';
import { readConfig } from './config';
import { d1Collaborators } from './repos/collaborators';
import { collaboratorsRpc } from './repos/collaborators-rpc';
import { deployTokensRpc } from './repos/deploy-tokens-rpc';
import { engineFeedRpc } from './repos/engine-feed';
import { peopleDirectory } from './repos/people';
import { repoEnginePort } from './repos/engine-port';
import { d1Registry } from './repos/registry';
import { newRepositoryId, repositoriesRpc } from './repos/repositories-rpc';
import { cleanupPortsFrom, repositoryCleanup } from './repos/repository-cleanup';
import { createDeps } from './deps';
import type { GatewayRpcSurface } from './rpc/gateway-rpc';
import { gatewayRpc } from './rpc/gateway-rpc';
import { collaborationRpc } from './rpc/collaboration-rpc';
import { repoEngineRpc } from './rpc/repo-engine-rpc';

export { RunDO } from './run/run-do';
export { RunIndex } from './run/run-index';
export { RunStreamDO } from './stream/run-stream-do';
export { RepoDerivedDO } from './derive/repo-derived-do';
export { Runner } from './runner/runner-container';
export { RunnerCapacity } from './capacity/runner-capacity';
export { ActionsRepoDO } from './actions/repo-do';
export { ActionsRunDO } from './actions/run-do';
export { Actions, ActionsJobs, StubActionsExecutor } from './actions/entrypoints';
// Required by @cloudflare/containers for outbound interception (allowed and denied hosts).
export { ContainerProxy } from '@cloudflare/containers';

/** Built once per isolate; the deps are injected per request from the request's env. */
const app = createApp(createDeps);

/**
 * gitstalk-gateway: race runs, the driver API, the git proxy and the live page over HTTP,
 * and the web app's RPC surface (`GatewayRpc`) over its service binding.
 */
export default class Gateway
  extends WorkerEntrypoint<Env>
  implements
    GatewayRpc,
    RepositoriesRpc,
    RepoEngineRpc,
    DeployTokensRpc,
    CollaboratorsRpc,
    AgentReposRpc,
    AgentActionsRpc,
    EngineFeedRpc,
    RepoIndexRpc,
    DerivedRpc,
    AccountsRpc,
    AutomationEditorRpc,
    RulesEditorRpc
{
  override async fetch(request: Request): Promise<Response> {
    return withHsts(request, await app.fetch(request, this.env, this.ctx));
  }

  /** `repo-events`: repository engines' events into the D1 indexes. */
  override async queue(batch: MessageBatch): Promise<void> {
    await consumeRepoEvents(batch, {
      db: this.env.FORGE,
      // Actions (doc 25 §2): the stalk moving is `push` to main; the repository's DO indexes.
      stalkMoved: (move) => this.env.ACTIONS_REPOS.getByName(move.repoId).stalkMoved(move),
      repoEvents: (input) => this.env.ACTIONS_REPOS.getByName(input.repoId).repoEvents(input),
      derived: (feed) => this.#feedDerived(feed),
      registry: d1Registry(this.env.FORGE, this.env),
      log: createLogger(readConfig(this.env).logLevel, { component: 'repo-events' }),
    });
  }

  /** Derived history (`derive/`): the repository's `RepoDerivedDO` records and derives in the background. */
  #feedDerived(feed: DerivedFeed): void {
    const log = createLogger(readConfig(this.env).logLevel, { component: 'repo-events' });
    this.ctx.waitUntil(
      this.env.DERIVED.getByName(feed.engine)
        .observe({ repo: feed.repo, events: feed.events })
        .catch((error: unknown) => {
          log.warn('derived history feed failed', { engine: feed.engine, error });
        }),
    );
  }

  /** Which bean last changed each line range of a file (derived history, `derive/`). */
  whyLines(run: string, input: WhyLinesInput): Promise<RpcResult<WhyLines>> {
    return this.#derived().whyLines(run, input);
  }

  /** The landings and reverts that touched a path, newest first (derived history). */
  pathHistory(run: string, input: PathHistoryInput): Promise<RpcResult<PathHistory>> {
    return this.#derived().pathHistory(run, input);
  }

  #derived(): DerivedRpc {
    return derivedRpc({
      registry: d1Registry(this.env.FORGE, this.env),
      derived: (engine) => this.env.DERIVED.getByName(engine),
    });
  }

  repositoryStalk(repoId: string, viewer: Viewer): Promise<RpcResult<RepositoryStalk>> {
    return this.#index().repositoryStalk(repoId, viewer);
  }

  repositoryGrowth(
    repoIds: readonly string[],
    viewer: Viewer,
  ): Promise<RpcResult<readonly RepositoryGrowth[]>> {
    return this.#index().repositoryGrowth(repoIds, viewer);
  }

  #index(): RepoIndexRpc {
    return repoIndexRpc({
      db: this.env.FORGE,
      registry: d1Registry(this.env.FORGE, this.env),
      collaborators: d1Collaborators(this.env.FORGE, () => Date.now(), this.env),
      engine: (engineId) => this.env.RUNS.getByName(engineId),
      waitUntil: (work) => this.ctx.waitUntil(work),
      log: createLogger(readConfig(this.env).logLevel, { component: 'repo-index' }),
    });
  }

  listRuns(limit?: number): Promise<readonly RunListItem[]> {
    return this.#rpc().listRuns(limit);
  }

  runView(run: string): Promise<RpcResult<RunView>> {
    return this.#rpc().runView(run);
  }

  runEvents(run: string, after: number, limit: number): Promise<RpcResult<RunEventsPage>> {
    return this.#rpc().runEvents(run, after, limit);
  }

  decide(
    run: string,
    card: string,
    winner: string,
    actor: string,
    text?: string,
  ): Promise<RpcResult<{ readonly accepted: true }>> {
    return this.#rpc().decide(run, card, winner, actor, text);
  }

  viewToken(run: string): Promise<RpcResult<ViewToken>> {
    return this.#rpc().viewToken(run);
  }

  repoTree(
    run: string,
    ref: string,
    path?: string,
    recursive?: boolean,
  ): Promise<RpcResult<RepoTree>> {
    return this.#rpc().repoTree(run, ref, path, recursive);
  }

  repoFile(run: string, ref: string, path: string): Promise<RpcResult<RepoFile>> {
    return this.#rpc().repoFile(run, ref, path);
  }

  repoDiff(
    run: string,
    fromRef: string,
    toRef: string,
    paths?: readonly string[],
  ): Promise<RpcResult<RepoDiff>> {
    return this.#rpc().repoDiff(run, fromRef, toRef, paths);
  }

  repoLog(
    run: string,
    ref: string,
    paths: readonly string[] | null,
    limit: number,
  ): Promise<RpcResult<RepoLog>> {
    return this.#rpc().repoLog(run, ref, paths, limit);
  }

  repoGrep(
    run: string,
    ref: string,
    pattern: string,
    paths?: readonly string[],
    regex?: boolean,
  ): Promise<RpcResult<RepoGrep>> {
    return this.#rpc().repoGrep(run, ref, pattern, paths, regex);
  }

  beansByPath(run: string, paths: readonly string[]): Promise<RpcResult<readonly BeanSummary[]>> {
    return this.#rpc().beansByPath(run, paths);
  }

  beanDetail(run: string, bean: string): Promise<RpcResult<BeanDetail>> {
    return this.#rpc().beanDetail(run, bean);
  }

  policyGet(run: string, ref?: string): Promise<RpcResult<ApprovalPolicyView>> {
    return this.#rpc().policyGet(run, ref);
  }

  beanRoute(run: string, bean: string): Promise<RpcResult<RouteReceipt | null>> {
    return this.#rpc().beanRoute(run, bean);
  }

  approveBean(
    run: string,
    bean: string,
    actor: string,
  ): Promise<RpcResult<{ readonly approved: true; readonly resubmitted: boolean }>> {
    return this.#rpc().approveBean(run, bean, actor);
  }

  decisions(run: string, paths?: readonly string[]): Promise<RpcResult<readonly DecisionRecord[]>> {
    return this.#rpc().decisions(run, paths);
  }

  testsFor(run: string, paths: readonly string[]): Promise<RpcResult<readonly TestCoverage[]>> {
    return this.#rpc().testsFor(run, paths);
  }

  beanStreams(run: string): Promise<RpcResult<readonly BeanStreamSummary[]>> {
    return this.#rpc().beanStreams(run);
  }

  beanStream(run: string, bean: string): Promise<RpcResult<BeanStream | null>> {
    return this.#rpc().beanStream(run, bean);
  }

  verifyViewToken(token: string): Promise<RpcResult<ViewTokenClaims>> {
    return this.#rpc().verifyViewToken(token);
  }

  verifyMcpToken(token: string): Promise<RpcResult<McpTokenClaims>> {
    return collaborationRpc(createDeps(this.env)).verifyMcpToken(token);
  }

  beanContext(run: string, input: BeanContextInput): Promise<RpcResult<BeanContext>> {
    return collaborationRpc(createDeps(this.env)).beanContext(run, input);
  }

  beanDiscover(run: string, input: BeanDiscoverInput): Promise<RpcResult<BeanDiscoverPage>> {
    return collaborationRpc(createDeps(this.env)).beanDiscover(run, input);
  }

  beanPeerSummaries(
    run: string,
    beans: readonly string[],
  ): Promise<RpcResult<readonly BeanPeerSummary[]>> {
    return collaborationRpc(createDeps(this.env)).beanPeerSummaries(run, beans);
  }

  beanUpdate(token: string, input: BeanUpdateInput): Promise<RpcResult<BeanUpdateResult>> {
    return collaborationRpc(createDeps(this.env)).beanUpdate(token, input);
  }

  beanCommit(token: string, input: BeanCommitInput): Promise<RpcResult<BeanCommitResult>> {
    return collaborationRpc(createDeps(this.env)).beanCommit(token, input);
  }

  beanThreadPost(
    token: string,
    input: BeanThreadPostInput,
  ): Promise<RpcResult<BeanThreadPostResult>> {
    return collaborationRpc(createDeps(this.env)).beanThreadPost(token, input);
  }

  beanInboxRead(token: string, input: BeanInboxReadInput): Promise<RpcResult<BeanInboxPage>> {
    return collaborationRpc(createDeps(this.env)).beanInboxRead(token, input);
  }

  beanInboxAck(token: string, input: BeanInboxAckInput): Promise<RpcResult<BeanInboxAckResult>> {
    return collaborationRpc(createDeps(this.env)).beanInboxAck(token, input);
  }

  createRepository(
    owner: RepoOwner,
    input: CreateRepositoryInput,
  ): Promise<RpcResult<RepositoryRecord>> {
    return this.#repositories().createRepository(owner, input);
  }

  listRepositories(
    ownerId: string,
    viewer: Viewer,
    listing?: RepositoryListing,
  ): Promise<RpcResult<readonly RepositoryRecord[]>> {
    return this.#repositories().listRepositories(ownerId, viewer, listing);
  }

  archiveRepository(
    actorId: string,
    repoId: string,
    to: RepositoryListing,
  ): Promise<RpcResult<RepositoryRecord>> {
    return this.#repositories().archiveRepository(actorId, repoId, to);
  }

  transferRepository(
    actorId: string,
    repoId: string,
    toHandle: string,
  ): Promise<RpcResult<RepositoryRecord>> {
    return this.#repositories().transferRepository(actorId, repoId, toHandle);
  }

  getRepository(
    ownerHandle: string,
    name: string,
    viewer: Viewer,
  ): Promise<RpcResult<RepositoryForViewer>> {
    return this.#repositories().getRepository(ownerHandle, name, viewer);
  }

  updateRepository(
    ownerId: string,
    repoId: string,
    patch: UpdateRepositoryInput,
  ): Promise<RpcResult<RepositoryRecord>> {
    return this.#repositories().updateRepository(ownerId, repoId, patch);
  }

  deleteRepository(
    ownerId: string,
    repoId: string,
  ): Promise<RpcResult<{ readonly deleted: true }>> {
    return this.#repositories().deleteRepository(ownerId, repoId);
  }

  repositoryActivity(
    ownerId: string,
    limit: number,
  ): Promise<RpcResult<readonly RepositoryActivity[]>> {
    return this.#repositories().repositoryActivity(ownerId, limit);
  }

  repositoryFiles(repoId: string, viewer: Viewer): Promise<RpcResult<RepositoryFiles>> {
    return this.#repositories().repositoryFiles(repoId, viewer);
  }

  createDeployToken(
    actor: DeployTokenActor,
    repoId: string,
    input: CreateDeployTokenInput,
  ): Promise<RpcResult<IssuedDeployToken>> {
    return this.#deployTokens().createDeployToken(actor, repoId, input);
  }

  listDeployTokens(
    actor: DeployTokenActor,
    repoId: string,
  ): Promise<RpcResult<readonly DeployTokenSummary[]>> {
    return this.#deployTokens().listDeployTokens(actor, repoId);
  }

  revokeDeployToken(
    actor: DeployTokenActor,
    repoId: string,
    tokenId: string,
  ): Promise<RpcResult<{ readonly revoked: boolean }>> {
    return this.#deployTokens().revokeDeployToken(actor, repoId, tokenId);
  }

  repositoryPeople(repoId: string, viewer: Viewer): Promise<RpcResult<RepositoryPeople>> {
    return this.#collaborators().repositoryPeople(repoId, viewer);
  }

  inviteCollaborator(
    actor: RepoOwner,
    repoId: string,
    input: InviteInput,
  ): Promise<RpcResult<Invitation>> {
    return this.#collaborators().inviteCollaborator(actor, repoId, input);
  }

  cancelInvitation(
    actor: RepoOwner,
    repoId: string,
    invitationId: string,
  ): Promise<RpcResult<{ readonly cancelled: true }>> {
    return this.#collaborators().cancelInvitation(actor, repoId, invitationId);
  }

  setCollaboratorRole(
    actor: RepoOwner,
    repoId: string,
    userId: string,
    role: RepoRole,
  ): Promise<RpcResult<Collaborator>> {
    return this.#collaborators().setCollaboratorRole(actor, repoId, userId, role);
  }

  removeCollaborator(
    actor: RepoOwner,
    repoId: string,
    userId: string,
  ): Promise<RpcResult<{ readonly removed: true }>> {
    return this.#collaborators().removeCollaborator(actor, repoId, userId);
  }

  myInvitations(userId: string): Promise<RpcResult<readonly Invitation[]>> {
    return this.#collaborators().myInvitations(userId);
  }

  answerInvitation(
    user: RepoOwner,
    invitationId: string,
    answer: 'accept' | 'decline',
  ): Promise<RpcResult<{ readonly owner_handle: string; readonly repo_name: string }>> {
    return this.#collaborators().answerInvitation(user, invitationId, answer);
  }

  sharedRepositories(userId: string): Promise<RpcResult<readonly RepositoryForViewer[]>> {
    return this.#collaborators().sharedRepositories(userId);
  }

  engineAccess(
    engineId: string,
    viewer: Viewer,
    action: RepositoryAction,
  ): Promise<RpcResult<{ readonly repository: RepositoryForViewer | null }>> {
    return this.#collaborators().engineAccess(engineId, viewer, action);
  }

  agentRepositoryAccess(
    agent: AgentPrincipal,
    ownerHandle: string,
    name: string,
    action: RepositoryAction,
  ): Promise<RpcResult<RepositoryForViewer>> {
    return this.#collaborators().agentRepositoryAccess(agent, ownerHandle, name, action);
  }

  #collaborators(): CollaboratorsRpc {
    return collaboratorsRpc({
      registry: d1Registry(this.env.FORGE, this.env),
      collaborators: d1Collaborators(this.env.FORGE, () => Date.now(), this.env),
      people: peopleDirectory(this.env, this.env.FORGE),
      log: createLogger(readConfig(this.env).logLevel, { component: 'collaborators' }),
    });
  }

  #deployTokens(): DeployTokensRpc {
    return deployTokensRpc({
      db: this.env.FORGE,
      now: () => Date.now(),
      registry: d1Registry(this.env.FORGE, this.env),
      collaborators: d1Collaborators(this.env.FORGE, () => Date.now(), this.env),
    });
  }

  renameOwner(
    userId: string,
    handle: string,
  ): Promise<RpcResult<{ readonly repositories: number }>> {
    return this.#accounts().renameOwner(userId, handle);
  }

  closeAccount(
    userId: string,
  ): Promise<RpcResult<{ readonly deletedRepositories: readonly string[] }>> {
    return this.#accounts().closeAccount(userId);
  }

  #accounts(): AccountsRpc {
    return accountsRpc({
      db: this.env.FORGE,
      registry: d1Registry(this.env.FORGE, this.env),
      engine: repoEnginePort(createDeps(this.env)),
      storage: repositoryStorage(this.env.REPOS),
      cleanup: this.#repositoryCleanup(),
      log: createLogger(readConfig(this.env).logLevel, { component: 'accounts' }),
    });
  }

  #repositoryCleanup() {
    const log = createLogger(readConfig(this.env).logLevel, { component: 'repository-cleanup' });
    return repositoryCleanup(cleanupPortsFrom(this.env, log));
  }

  #repositories(): RepositoriesRpc {
    return repositoriesRpc({
      registry: d1Registry(this.env.FORGE, this.env),
      collaborators: d1Collaborators(this.env.FORGE, () => Date.now(), this.env),
      identity: this.env,
      storage: repositoryStorage(this.env.REPOS),
      engine: repoEnginePort(createDeps(this.env)),
      cleanup: this.#repositoryCleanup(),
      log: createLogger(readConfig(this.env).logLevel, { component: 'repositories' }),
      now: () => Date.now(),
      newId: newRepositoryId,
      webUrl: readConfig(this.env).webUrl,
    });
  }

  openRepoEngine(input: OpenRepoEngineInput): Promise<RpcResult<RepoEngineOpened>> {
    return repoEngineRpc(createDeps(this.env)).openRepoEngine(input);
  }

  gitToken(
    engineId: string,
    user: { readonly id: string; readonly handle: string },
    ttlSeconds?: number,
  ): Promise<RpcResult<GitToken>> {
    return repoEngineRpc(createDeps(this.env)).gitToken(engineId, user, ttlSeconds);
  }

  pushedBeans(engineId: string): Promise<RpcResult<readonly PushedBeanStatus[]>> {
    return repoEngineRpc(createDeps(this.env)).pushedBeans(engineId);
  }

  /** What happened lately in each engine, for a person's Home (`EngineFeedRpc`). */
  engineFeeds(
    engineIds: readonly string[],
    limit: number,
  ): Promise<RpcResult<readonly EngineFeed[]>> {
    return engineFeedRpc(createDeps(this.env)).engineFeeds(engineIds, limit);
  }

  closeRepoEngine(
    engineId: string,
    options: { readonly deleteRepo: boolean },
  ): Promise<RpcResult<{ readonly closed: true }>> {
    return repoEngineRpc(createDeps(this.env)).closeRepoEngine(engineId, options);
  }

  agentRepositories(principal: AgentPrincipal): Promise<RpcResult<readonly AgentRepository[]>> {
    return this.#agents().agentRepositories(principal);
  }

  agentRepository(principal: AgentPrincipal, repo: string): Promise<RpcResult<AgentRepository>> {
    return this.#agents().agentRepository(principal, repo);
  }

  agentPushedBeans(
    principal: AgentPrincipal,
    repo: string,
  ): Promise<RpcResult<readonly PushedBeanStatus[]>> {
    return this.#agents().agentPushedBeans(principal, repo);
  }

  agentBean(principal: AgentPrincipal, repo: string, bean: string): Promise<RpcResult<AgentBean>> {
    return this.#agents().agentBean(principal, repo, bean);
  }

  agentWaitBean(
    principal: AgentPrincipal,
    repo: string,
    bean: string,
    wait: { readonly until: BeanWaitUntil; readonly seconds: number },
  ): Promise<RpcResult<BeanWaited>> {
    return this.#agents().agentWaitBean(principal, repo, bean, wait);
  }

  agentOpenBean(
    principal: AgentPrincipal,
    repo: string,
    input: BeanOpenInput,
  ): Promise<RpcResult<BeanOpened>> {
    return this.#agents().agentOpenBean(principal, repo, input);
  }

  agentBacklog(principal: AgentPrincipal, repo: string): Promise<RpcResult<Backlog>> {
    return this.#agents().agentBacklog(principal, repo);
  }

  agentClaimTask(
    principal: AgentPrincipal,
    repo: string,
    task: string,
  ): Promise<RpcResult<TaskClaimed>> {
    return this.#agents().agentClaimTask(principal, repo, task);
  }

  agentReleaseTask(
    principal: AgentPrincipal,
    repo: string,
    task: string,
  ): Promise<RpcResult<TaskClaimed>> {
    return this.#agents().agentReleaseTask(principal, repo, task);
  }

  agentAutomations(principal: AgentPrincipal, repo: string): Promise<RpcResult<AgentAutomations>> {
    return this.#agents().agentAutomations(principal, repo);
  }

  agentCommitBean(
    principal: AgentPrincipal,
    repo: string,
    input: BeanCommitInput,
  ): Promise<RpcResult<BeanCommitResult>> {
    return this.#agents().agentCommitBean(principal, repo, input);
  }

  // Actions for agent sessions (doc 23 §5): workflows, runs, logs, secrets, automations.

  agentWorkflows(principal: AgentPrincipal, repo: string): Promise<RpcResult<AgentWorkflows>> {
    return this.#agentActions().agentWorkflows(principal, repo);
  }

  agentRuns(
    principal: AgentPrincipal,
    repo: string,
    filter: AgentRunFilter,
  ): Promise<RpcResult<AgentRunPage>> {
    return this.#agentActions().agentRuns(principal, repo, filter);
  }

  agentRun(principal: AgentPrincipal, repo: string, run: string): Promise<RpcResult<AgentRun>> {
    return this.#agentActions().agentRun(principal, repo, run);
  }

  agentJobLog(
    principal: AgentPrincipal,
    repo: string,
    input: AgentJobLogInput,
  ): Promise<RpcResult<AgentJobLog>> {
    return this.#agentActions().agentJobLog(principal, repo, input);
  }

  agentDispatch(
    principal: AgentPrincipal,
    repo: string,
    input: AgentDispatchInput,
  ): Promise<RpcResult<AgentRunSummary>> {
    return this.#agentActions().agentDispatch(principal, repo, input);
  }

  agentRerun(
    principal: AgentPrincipal,
    repo: string,
    run: string,
  ): Promise<RpcResult<AgentRunSummary>> {
    return this.#agentActions().agentRerun(principal, repo, run);
  }

  agentCancel(
    principal: AgentPrincipal,
    repo: string,
    run: string,
  ): Promise<RpcResult<AgentRunSummary>> {
    return this.#agentActions().agentCancel(principal, repo, run);
  }

  agentWaitRun(
    principal: AgentPrincipal,
    repo: string,
    input: AgentWaitRunInput,
  ): Promise<RpcResult<AgentRunWaited>> {
    return this.#agentActions().agentWaitRun(principal, repo, input);
  }

  agentActionsEntries(
    principal: AgentPrincipal,
    repo: string,
  ): Promise<RpcResult<AgentActionsEntries>> {
    return this.#agentActions().agentActionsEntries(principal, repo);
  }

  agentPutSecret(
    principal: AgentPrincipal,
    repo: string,
    input: AgentPutSecretInput,
  ): Promise<RpcResult<AgentEntrySaved>> {
    return this.#agentActions().agentPutSecret(principal, repo, input);
  }

  agentDeleteSecret(
    principal: AgentPrincipal,
    repo: string,
    input: AgentEntryRef,
  ): Promise<RpcResult<AgentEntryDeleted>> {
    return this.#agentActions().agentDeleteSecret(principal, repo, input);
  }

  agentPutVariable(
    principal: AgentPrincipal,
    repo: string,
    input: AgentPutVariableInput,
  ): Promise<RpcResult<AgentEntrySaved>> {
    return this.#agentActions().agentPutVariable(principal, repo, input);
  }

  agentDeleteVariable(
    principal: AgentPrincipal,
    repo: string,
    input: AgentEntryRef,
  ): Promise<RpcResult<AgentEntryDeleted>> {
    return this.#agentActions().agentDeleteVariable(principal, repo, input);
  }

  agentAutomation(
    principal: AgentPrincipal,
    repo: string,
    automation: string,
  ): Promise<RpcResult<AgentAutomation>> {
    return this.#agentActions().agentAutomation(principal, repo, automation);
  }

  agentRunAutomation(
    principal: AgentPrincipal,
    repo: string,
    automation: string,
  ): Promise<RpcResult<AgentAutomationStarted>> {
    return this.#agentActions().agentRunAutomation(principal, repo, automation);
  }

  #agentActions(): AgentActionsRpc {
    return agentActionsRpc(this.env, createDeps(this.env));
  }

  // The automation builder (doc 25 §7.13): open a file, save it as a bean, follow the bean,
  // and run a draft once by hand.

  automationSource(
    viewer: Viewer,
    repoId: string,
    path: string,
  ): Promise<RpcResult<AutomationSource>> {
    return this.#automations().automationSource(viewer, repoId, path);
  }

  saveAutomation(
    viewer: Viewer,
    repoId: string,
    input: SaveAutomationInput,
  ): Promise<RpcResult<SaveAutomationResult>> {
    return this.#automations().saveAutomation(viewer, repoId, input);
  }

  automationBean(
    viewer: Viewer,
    repoId: string,
    bean: string,
  ): Promise<RpcResult<AutomationBeanStatus>> {
    return this.#automations().automationBean(viewer, repoId, bean);
  }

  testAutomation(
    viewer: Viewer,
    repoId: string,
    input: TestAutomationInput,
  ): Promise<RpcResult<{ readonly runId: string }>> {
    return this.#automations().testAutomation(viewer, repoId, input);
  }

  rulesSource(viewer: Viewer, repoId: string): Promise<RpcResult<RulesSource>> {
    return this.#rules().rulesSource(viewer, repoId);
  }

  saveRules(
    viewer: Viewer,
    repoId: string,
    input: SaveRulesInput,
  ): Promise<RpcResult<SaveAutomationResult>> {
    return this.#rules().saveRules(viewer, repoId, input);
  }

  rulesBean(
    viewer: Viewer,
    repoId: string,
    bean: string,
  ): Promise<RpcResult<AutomationBeanStatus>> {
    return this.#rules().rulesBean(viewer, repoId, bean);
  }

  #rules(): RulesEditorRpc {
    return rulesEditorRpc(this.env, createDeps(this.env));
  }

  #automations(): AutomationEditorRpc {
    return automationEditorRpc(this.env, createDeps(this.env));
  }

  #agents(): Required<AgentReposRpc> {
    return agentReposRpc(createDeps(this.env));
  }

  /**
   * Git over SSH (the `beanstalk-ssh` Worker's binding): whose key `publicKey` is. `confirm`
   * marks a signature-checked use. Null for a key nobody registered.
   */
  sshKeyLookup(publicKey: string, confirm: boolean): Promise<SshKeyAnswer | null> {
    return lookupSshKey({ publicKey, confirm }, this.#ssh());
  }

  /** Git over SSH: one smart-HTTP request served as the owner of `publicKey`. */
  sshGit(publicKey: string, request: Request): Promise<Response> {
    return serveSshGit({ publicKey, request }, this.#ssh(), this.ctx);
  }

  #ssh(): SshDeps {
    return { deps: createDeps(this.env), keys: sshKeyStore(this.env) };
  }

  #rpc(): GatewayRpcSurface {
    return gatewayRpc(this.env, createDeps(this.env));
  }
}
