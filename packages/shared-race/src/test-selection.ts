import { z } from 'zod';
import { Sha } from './ids';

/** Counts and files describe executions, never pretend carried evidence ran again. */
export const TestSelection = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('full'),
    reason: z.string(),
    baseline_sha: z.null(),
    selected_files: z.array(z.string()),
    skipped_files: z.array(z.string()).length(0),
  }),
  z.strictObject({
    mode: z.literal('selected'),
    reason: z.string(),
    baseline_sha: Sha,
    selected_files: z.array(z.string()).min(1),
    skipped_files: z.array(z.string()).min(1),
  }),
]);
export type TestSelection = z.infer<typeof TestSelection>;
