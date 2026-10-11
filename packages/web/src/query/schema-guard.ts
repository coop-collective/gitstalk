/**
 * A `zod/mini` schema as a type guard for `fetchJson`. `zod/mini` is the tree-shakable build:
 * import schemas from it (not from `zod`) in modules that end up in client bundles.
 *
 * The guard narrows the value as received, so use schemas without transforms or defaults.
 *
 * ```ts
 * import * as z from 'zod/mini';
 * const Activity = z.array(z.object({ seq: z.number(), kind: z.string() }));
 * fetchJson('/api/home/activity', schemaGuard(Activity), { signal });
 * ```
 */
import * as z from 'zod/mini';

export function schemaGuard<S extends z.ZodMiniType>(
  schema: S,
): (value: unknown) => value is z.infer<S> {
  return (value: unknown): value is z.infer<S> => z.safeParse(schema, value).success;
}
