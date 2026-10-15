/**
 * Every language `bean-links.ts` reads, by file extension (`language.ts`).
 */
import { javascript } from './javascript';
import type { Language } from './language';
import { python } from './python';
import { ruby } from './ruby';
import { java } from './java';
import { kotlin } from './kotlin';
import { csharp } from './csharp';
import { swift } from './swift';
import { go } from './go';
import { rust } from './rust';
import { cFamily } from './c-family';
import { php } from './php';

export const LANGUAGES: readonly Language[] = [
  javascript,
  python,
  ruby,
  java,
  kotlin,
  csharp,
  swift,
  go,
  rust,
  cFamily,
  php,
];

const BY_EXTENSION: ReadonlyMap<string, Language> = new Map(
  LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language])),
);

/** The language of a path by its last extension (case-insensitive), or null. */
export function languageOf(path: string): Language | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return null;
  return BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? null;
}
