/**
 * The wire shapes of streaming diffs: what the run's stream socket and the `beanStream` RPC
 * carry. Zod only, so a module that just parses messages does not take the diff code with it.
 */
import { z } from 'zod';

const Status = z.enum(['added', 'modified', 'deleted']);

export const BeanStreamSummary = z.object({
  type: z.literal('bean.streaming'),
  task: z.string(),
  inv: z.string(),
  agent: z.string(),
  seq: z.number().int(),
  t: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      status: Status,
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
  additions: z.number().int(),
  deletions: z.number().int(),
  truncated: z.boolean(),
  redacted: z.number().int().default(0),
});
export type BeanStreamSummary = z.infer<typeof BeanStreamSummary>;

export const BeanStreamEnd = z.object({
  type: z.literal('bean.streaming.end'),
  task: z.string(),
  inv: z.string(),
  t: z.number(),
});
export type BeanStreamEnd = z.infer<typeof BeanStreamEnd>;

/** A summary or an end: what every viewer gets. */
export const BeanStreamMessage = z.discriminatedUnion('type', [BeanStreamSummary, BeanStreamEnd]);
export type BeanStreamMessage = z.infer<typeof BeanStreamMessage>;

export const StreamFile = z.object({
  path: z.string(),
  status: Status,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  patch: z.string().nullable(),
});
export type StreamFile = z.infer<typeof StreamFile>;

/** A subscribed bean's whole snapshot, sent when the viewer subscribes to it. */
export const BeanStreamSnapshot = z.object({
  type: z.literal('bean.snapshot'),
  task: z.string(),
  inv: z.string(),
  seq: z.number().int(),
  files: z.array(StreamFile),
});
export type BeanStreamSnapshot = z.infer<typeof BeanStreamSnapshot>;

/** What one accepted post changed in a subscribed bean; `base_seq: 0` replaces the snapshot. */
export const BeanStreamPatch = z.object({
  type: z.literal('bean.patch'),
  task: z.string(),
  inv: z.string(),
  seq: z.number().int(),
  base_seq: z.number().int(),
  files: z.array(StreamFile),
  removed: z.array(z.string()),
});
export type BeanStreamPatch = z.infer<typeof BeanStreamPatch>;

/** Any message of the run's stream socket. */
export const BeanStreamSocketMessage = z.discriminatedUnion('type', [
  BeanStreamSummary,
  BeanStreamEnd,
  BeanStreamSnapshot,
  BeanStreamPatch,
]);
export type BeanStreamSocketMessage = z.infer<typeof BeanStreamSocketMessage>;

export const BeanStreamAnswer = z
  .object({ summary: BeanStreamSummary, files: z.array(StreamFile) })
  .nullable();
