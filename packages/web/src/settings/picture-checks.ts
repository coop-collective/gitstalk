/**
 * The checks the browser makes before the crop dialog opens, with the server's own codes so
 * the message is the one the upload route would have shown (`src/account/picture-notes.ts`).
 * The server still checks everything from the bytes; these only spare a pointless upload.
 */
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MIN_IMAGE_SIDE } from '@gitstalk/shared-media/images';

import type { PictureCode } from '../account/picture-notes';
import { pictureCode } from '../account/picture-notes';
import type { Size } from './picture-crop';

/** What the file chooser offers; the same four types the server takes. */
export const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export type PictureRefusal = Extract<
  PictureCode,
  'empty' | 'svg' | 'unsupported_type' | 'too_large' | 'too_small' | 'too_big'
>;

const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/** Why a chosen file cannot be used, or null when it can be opened. */
export function fileRefusal(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): PictureRefusal | null {
  const type = pictureType(file);
  if (file.size === 0) return 'empty';
  if (type === 'image/svg+xml') return 'svg';
  if (!PICTURE_ACCEPT.split(',').includes(type)) return 'unsupported_type';
  if (file.size > MAX_IMAGE_BYTES) return 'too_large';
  return null;
}

/** Why a decoded image's size cannot be used, or null. */
export function sideRefusal(image: Size): PictureRefusal | null {
  if (Math.min(image.width, image.height) < MIN_IMAGE_SIDE) return 'too_small';
  if (Math.max(image.width, image.height) > MAX_IMAGE_SIDE) return 'too_big';
  return null;
}

/** The browser's type, or one from the extension when the browser gave none. */
export function pictureType(file: { readonly name: string; readonly type: string }): string {
  if (file.type !== '') return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TYPES_BY_EXTENSION[extension] ?? '';
}

/**
 * The `?picture=` code on the page an upload's redirect ended on, or null when it ended
 * anywhere else (signed out, not found).
 */
export function uploadOutcome(finalUrl: string): PictureCode | null {
  try {
    return pictureCode(new URL(finalUrl).searchParams.get('picture'));
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
