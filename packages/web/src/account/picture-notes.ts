/**
 * What a picture upload did, carried across its redirect as a code (`?picture=too_large`) and
 * shown from this fixed table, so a link cannot make the page say anything else.
 */
import type { UploadRefusalCode } from '@gitstalk/shared-media/images';

export type PictureCode = UploadRefusalCode | 'updated' | 'removed';
export type PictureNote = { readonly kind: 'saved' | 'error'; readonly text: string };

const NOTES: Readonly<Record<PictureCode, PictureNote>> = {
  updated: { kind: 'saved', text: 'Picture updated.' },
  removed: { kind: 'saved', text: 'Picture removed: the generated one is back.' },
  empty: { kind: 'error', text: 'Choose an image file.' },
  too_large: { kind: 'error', text: 'Images can be up to 2 MB. Pick a smaller one.' },
  svg: {
    kind: 'error',
    text: 'SVG files can carry scripts, so they are not taken. Use PNG, JPEG, WebP or GIF.',
  },
  unsupported_type: { kind: 'error', text: 'Use a PNG, JPEG, WebP or GIF image.' },
  corrupt: { kind: 'error', text: 'That image could not be read. Try saving it again.' },
  too_small: { kind: 'error', text: 'Use an image at least 16 pixels on each side.' },
  too_big: { kind: 'error', text: 'Use an image at most 4096 pixels on each side.' },
  bad_owner: { kind: 'error', text: 'That picture could not be saved. Reload and try again.' },
};

export function pictureNoteParam(code: PictureCode): string {
  return `picture=${code}`;
}

/** The note for a `?picture=` value, or null for anything not in the table. */
export function pictureNote(value: string | undefined): PictureNote | null {
  return value !== undefined && isPictureCode(value) ? NOTES[value] : null;
}

function isPictureCode(value: string): value is PictureCode {
  return Object.hasOwn(NOTES, value);
}

/** The code a `?picture=` value names, or null for anything not in the table. */
export function pictureCode(value: string | null | undefined): PictureCode | null {
  return typeof value === 'string' && isPictureCode(value) ? value : null;
}

/** The note for a code this app produced itself (the browser's own checks). */
export function noteFor(code: PictureCode): PictureNote {
  return NOTES[code];
}
