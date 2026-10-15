/**
 * Gateway-wide flags (forge D1 `gateway_flags`): one JSON value per name, validated when read.
 * `halt` is the kill switch; `run_index_backfill` records the one-time copy of RunIndex.
 */
import { z } from 'zod';

export type FlagName = 'halt' | 'run_index_backfill';

/** The kill switch's value (`halt`), while runs are halted. */
export const Halt = z.object({ reason: z.string(), at: z.string() });
export type Halt = z.infer<typeof Halt>;

/** How a flag is written. */
export type FlagWrite = 'replace' | 'keep-existing';

/** The flag's value, or null when it is unset or no longer validates. */
export async function readFlag<T>(
  db: D1Database,
  name: FlagName,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const row = await db
    .prepare('SELECT value FROM gateway_flags WHERE name = ?')
    .bind(name)
    .first<{ value: string }>();
  if (row === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    // Not JSON: read as unset, like a value that fails validation.
    return null;
  }
}

/** Sets the flag; `keep-existing` leaves a flag that is already set as it is. */
export async function writeFlag(
  db: D1Database,
  flag: { readonly name: FlagName; readonly value: unknown; readonly atMs: number },
  write: FlagWrite = 'replace',
): Promise<void> {
  const onConflict =
    write === 'replace'
      ? 'DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      : 'DO NOTHING';
  await db
    .prepare(
      `INSERT INTO gateway_flags (name, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) ${onConflict}`,
    )
    .bind(flag.name, JSON.stringify(flag.value), flag.atMs)
    .run();
}

export async function clearFlag(db: D1Database, name: FlagName): Promise<void> {
  await db.prepare('DELETE FROM gateway_flags WHERE name = ?').bind(name).run();
}
