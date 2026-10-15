/**
 * Gateway-wide spend guards, admin only: the kill switch (`/halt`), an on-demand run of the
 * hourly repo sweep (`/sweep`, for runs older than `older_than_hours`), the runner pool's
 * state (`/capacity`: race reservations, repositories' sandbox leases, per-owner counts), and
 * the one-time copy of the deprecated RunIndex into D1 (`/runs/backfill`, idempotent).
 */
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../app-env';
import { requireAdmin } from '../middleware/auth';
import { backfillRunIndex } from '../run/run-index-backfill';
import { REPO_MAX_AGE_MS } from '../run/spend-guards';
import { validate } from './validation';

const HOUR_MS = 60 * 60 * 1000;

const HaltBody = z.strictObject({ reason: z.string().min(1).max(200).default('halted by admin') });

const SweepBody = z.strictObject({
  older_than_hours: z
    .number()
    .min(0)
    .max(24 * 365)
    .default(REPO_MAX_AGE_MS / HOUR_MS),
});

export const guardRoutes = new Hono<AppEnv>()
  .get('/halt', requireAdmin, async (c) => {
    return c.json({ halt: await c.var.deps.guards.halted() });
  })
  .post('/halt', requireAdmin, validate('json', HaltBody), async (c) => {
    return c.json({ halt: await c.var.deps.guards.halt(c.req.valid('json').reason) });
  })
  .delete('/halt', requireAdmin, async (c) => {
    await c.var.deps.guards.resume();
    return c.json({ halt: null });
  })
  .get('/capacity', requireAdmin, async (c) => {
    return c.json(await c.var.deps.runnerPool().snapshot());
  })
  .post('/sweep', requireAdmin, validate('json', SweepBody), async (c) => {
    const deps = c.var.deps;
    const startedBeforeMs = deps.now() - c.req.valid('json').older_than_hours * HOUR_MS;
    return c.json(await deps.guards.sweep(startedBeforeMs));
  })
  .post('/runs/backfill', requireAdmin, async (c) => {
    const deps = c.var.deps;
    return c.json(
      await backfillRunIndex({
        db: deps.forge,
        index: deps.runIndex,
        now: deps.now,
        log: deps.log,
      }),
    );
  });
