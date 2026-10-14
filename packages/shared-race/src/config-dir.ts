/**
 * A repository's own configuration directory: `.gitstalk/` (checks.yml, policy.yml, backlog.md,
 * automations/). Repositories made before the product was renamed (2026-10-10) keep theirs in
 * `.beanstalk/`, which is still read. The rule, everywhere a file is looked up: `.gitstalk/`
 * wins, `.beanstalk/` is read only when the `.gitstalk/` file is absent. New files are written
 * under `.gitstalk/`; an existing file is edited where it is.
 */

/** The documented directory. */
export const CONFIG_DIR = '.gitstalk';

/** The directory from before the rename, read as a fallback. */
export const LEGACY_CONFIG_DIR = '.beanstalk';

/** Both directories, in the order a lookup tries them. */
export const CONFIG_DIRS: readonly string[] = [CONFIG_DIR, LEGACY_CONFIG_DIR];

/** `name` in each directory, in lookup order: `.gitstalk/<name>`, then `.beanstalk/<name>`. */
export function configPaths(name: string): readonly string[] {
  return CONFIG_DIRS.map((dir) => `${dir}/${name}`);
}

/** A file read from the configuration directory: where it was found and what it says. */
export type ConfigFile = { readonly path: string; readonly text: string };

/**
 * The first of `paths` that `read` finds (it answers null for an absent file). All are read at
 * once, so the fallback costs no extra round trip.
 */
export async function readFirstPresent(
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<ConfigFile | null> {
  const texts = await Promise.all(paths.map(read));
  const index = texts.findIndex((text) => text !== null);
  const path = paths[index];
  const text = texts[index];
  return path === undefined || text === undefined || text === null ? null : { path, text };
}
