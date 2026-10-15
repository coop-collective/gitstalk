/**
 * Admin and read-only run routes. Creating, seeding, starting and stopping runs and
 * answering decision cards and reaping repos needs the admin token; reading a run (state, summary, events,
 * live feed) also accepts its view token.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { DecisionBody } from '@gitstalk/shared-race/driver';
import type { RunId } from '@gitstalk/shared-race/ids';
import { slotIds } from '@gitstalk/shared-race/ids';
import { AffectedQuery } from '@gitstalk/shared-race/read-maps';
import { RunConfig } from '@gitstalk/shared-race/run-config';

import type { AppEnv } from '../app-env';
import { issueToken } from '../auth/tokens';
import { SUPPORTED_POLICIES } from '../engine/model';
import { SPROUT_REF, STALK_REF } from '../engine/refs';
import { GatewayError } from '../errors';
import { requireAdmin, requireReader } from '../middleware/auth';
import type { Deps } from '../deps';
import { SEED_REFS } from '../run/git-access';
import { newRunId, runRepoName } from '../run/run-names';
import { unwrap } from './respond';
import { RunParam, validate } from './validation';

/** A run config with 200 tasks and their tests stays far below this. */
const MAX_RUN_CONFIG_BYTES = 8 * 1024 * 1024;
/** View links (the live page) stay valid for a week. */
const VIEW_TOKEN_TTL_SECONDS = 7 * 24 * 3600;
/** The seed token only needs to outlive one push. */
const SEED_TOKEN_TTL_SECONDS = 15 * 60;
/** Events per page of `GET /events`. */
const MAX_EVENTS_PAGE = 5000;

const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_PAGE).default(MAX_EVENTS_PAGE),
  format: z.enum(['json', 'jsonl']).default('json'),
});

const StopBody = z.strictObject({ reason: z.string().min(1).max(200).default('stopped by admin') });

const ReapBody = z.strictObject({ dry_run: z.boolean().default(true) });

const TreeParams = z.object({
  run: RunParam.shape.run,
  tree: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?(\+[0-9a-f]+)?$/),
});

const CardParams = z.object({ run: RunParam.shape.run, card: z.string().regex(/^D\d{3,6}$/) });

export const adminRoutes = new Hono<AppEnv>()
  .post(
    '/',
    requireAdmin,
    bodyLimit({ maxSize: MAX_RUN_CONFIG_BYTES }),
    validate('json', RunConfig),
    async (c) => {
      const config = c.req.valid('json');
      if (!SUPPORTED_POLICIES.includes(config.policy)) {
        throw new GatewayError(
          `policy ${config.policy} is not implemented yet`,
          'policy_not_implemented',
          422,
        );
      }
      if (config.continuous) {
        throw new GatewayError(
          'a continuous engine drives a repository: open it with POST /v1/repos',
          'invalid_request',
          400,
        );
      }
      const deps = c.var.deps;
      await refuseWhenHalted(deps);
      const run = newRunId();
      unwrap(await deps.run(run).createRun({ run, config, createdAtMs: deps.now() }));
      const origin = new URL(c.req.url).origin;
      return c.json(
        {
          run,
          policy: config.policy,
          agents: config.agents,
          repo: {
            name: runRepoName(run),
            url: gitUrl(origin, deps, runRepoName(run)),
            sprout: SPROUT_REF,
            stalk: STALK_REF,
          },
          slots: await slotTokens(deps, run, config.agents),
          view: await viewLinks(deps, run, origin),
        },
        201,
      );
    },
  )
  .post('/:run/seed-token', requireAdmin, validate('param', RunParam), async (c) => {
    const { run } = c.req.valid('param');
    const deps = c.var.deps;
    unwrap(await deps.run(run).agentCount());
    const issued = await issueToken(
      deps.tokenSecret,
      { run, sub: 'admin', scope: 'seed' },
      { ttlSeconds: SEED_TOKEN_TTL_SECONDS, nowMs: deps.now() },
    );
    const pushUrl = gitUrl(new URL(c.req.url).origin, deps, runRepoName(run));
    const refspecs = SEED_REFS.map((ref) => `<base-sha>:${ref}`).join(' ');
    return c.json({
      repo: runRepoName(run),
      push_url: pushUrl,
      token: issued.token,
      expires_at: issued.expiresAt,
      refs: SEED_REFS,
      example: `git -c http.extraHeader="Authorization: Bearer $SEED_TOKEN" push ${pushUrl} ${refspecs}`,
    });
  })
  .post('/:run/start', requireAdmin, validate('param', RunParam), async (c) => {
    const { run } = c.req.valid('param');
    await refuseWhenHalted(c.var.deps);
    const started = unwrap(await c.var.deps.run(run).start());
    return c.json({ run, phase: 'running', base_sha: started.baseSha });
  })
  .post(
    '/:run/stop',
    requireAdmin,
    validate('param', RunParam),
    validate('json', StopBody),
    async (c) => {
      const { run } = c.req.valid('param');
      const stopped = unwrap(await c.var.deps.run(run).stop(c.req.valid('json').reason));
      return c.json({ run, phase: stopped.phase });
    },
  )
  .post('/:run/tokens', requireAdmin, validate('param', RunParam), async (c) => {
    const { run } = c.req.valid('param');
    const deps = c.var.deps;
    const agents = unwrap(await deps.run(run).agentCount());
    return c.json({ run, slots: await slotTokens(deps, run, agents) });
  })
  .post('/:run/view-token', requireAdmin, validate('param', RunParam), async (c) => {
    const { run } = c.req.valid('param');
    const deps = c.var.deps;
    unwrap(await deps.run(run).agentCount());
    return c.json({ run, ...(await viewLinks(deps, run, new URL(c.req.url).origin)) });
  })
  .post(
    '/:run/decisions/:card',
    requireAdmin,
    validate('param', CardParams),
    validate('json', DecisionBody),
    async (c) => {
      const { run, card } = c.req.valid('param');
      const { winner, text } = c.req.valid('json');
      unwrap(
        await c.var.deps.run(run).decide(card, { winner, actor: 'admin', text: text ?? null }),
      );
      return c.json({ run, card, winner, accepted: true });
    },
  )
  .post(
    '/:run/reap',
    requireAdmin,
    validate('param', RunParam),
    validate('json', ReapBody),
    async (c) => {
      const { run } = c.req.valid('param');
      const dryRun = c.req.valid('json').dry_run;
      const report = unwrap(await c.var.deps.run(run).reap(run, dryRun ? 'list' : 'delete'));
      return c.json({ run, dry_run: dryRun, ...report });
    },
  );

/** Read-only run routes: the admin token or the run's view token. */
export const readRoutes = new Hono<AppEnv>()
  .get('/:run', requireReader, validate('param', RunParam), async (c) => {
    return c.json(unwrap(await c.var.deps.run(c.req.valid('param').run).view()));
  })
  .get('/:run/summary', requireReader, validate('param', RunParam), async (c) => {
    return jsonText(c, unwrap(await c.var.deps.run(c.req.valid('param').run).summary()));
  })
  .get(
    '/:run/events',
    requireReader,
    validate('param', RunParam),
    validate('query', EventsQuery),
    async (c) => {
      const { after, limit, format } = c.req.valid('query');
      const page = unwrap(await c.var.deps.run(c.req.valid('param').run).events(after, limit));
      if (format === 'jsonl') {
        const text = page.bodies.length > 0 ? `${page.bodies.join('\n')}\n` : '';
        return c.body(text, 200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      }
      return jsonText(
        c,
        `{"events":[${page.bodies.join(',')}],"next_after":${page.last},"done":${page.done}}`,
      );
    },
  )
  .get('/:run/read-maps', requireReader, validate('param', RunParam), async (c) => {
    return c.json(unwrap(await c.var.deps.run(c.req.valid('param').run).readMapSummary()));
  })
  .get('/:run/read-maps/trees/:tree', requireReader, validate('param', TreeParams), async (c) => {
    const { run, tree } = c.req.valid('param');
    return c.json(unwrap(await c.var.deps.run(run).readMapTree(tree)));
  })
  .post(
    '/:run/read-maps/affected',
    requireReader,
    bodyLimit({ maxSize: MAX_RUN_CONFIG_BYTES }),
    validate('param', RunParam),
    validate('json', AffectedQuery),
    async (c) => {
      const run = c.var.deps.run(c.req.valid('param').run);
      return c.json(unwrap(await run.readMapsAffected(c.req.valid('json'))));
    },
  )
  .get('/:run/live', requireReader, validate('param', RunParam), async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      throw new GatewayError('the live feed is a WebSocket', 'upgrade_required', 400);
    }
    return c.var.deps.run(c.req.valid('param').run).fetch(c.req.raw);
  });

/** The kill switch refuses new runs and starts (`POST /v1/admin/halt`). */
async function refuseWhenHalted(deps: Deps): Promise<void> {
  const halt = await deps.guards.halted();
  if (halt !== null)
    throw new GatewayError(`runs are halted since ${halt.at}: ${halt.reason}`, 'halted', 503);
}

/** A body that is already JSON text. */
function jsonText(c: Context<AppEnv>, text: string): Response {
  return c.body(text, 200, { 'content-type': 'application/json; charset=utf-8' });
}

function gitUrl(origin: string, deps: Deps, repo: string): string {
  return `${origin}/git/${deps.config.namespace}/${repo}.git`;
}

async function slotTokens(deps: Deps, run: RunId, agents: number) {
  return Promise.all(
    slotIds(agents).map(async (slot) => {
      const issued = await issueToken(
        deps.tokenSecret,
        { run, sub: slot, scope: 'slot' },
        { ttlSeconds: deps.config.runTokenTtlSeconds, nowMs: deps.now() },
      );
      return { slot, token: issued.token, expires_at: issued.expiresAt };
    }),
  );
}

async function viewLinks(deps: Deps, run: RunId, origin: string) {
  const issued = await issueToken(
    deps.tokenSecret,
    { run, sub: 'admin', scope: 'view' },
    { ttlSeconds: VIEW_TOKEN_TTL_SECONDS, nowMs: deps.now() },
  );
  return {
    token: issued.token,
    expires_at: issued.expiresAt,
    live_url: `${origin}/runs/${run}?key=${issued.token}`,
    events_url: `${origin}/v1/runs/${run}/events?key=${issued.token}`,
  };
}
