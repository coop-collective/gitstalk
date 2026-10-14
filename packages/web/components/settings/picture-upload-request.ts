/**
 * Sends a cropped picture to the same route the plain form posts to, as the same multipart
 * body, with upload progress. The route answers with a redirect to `?picture=<code>`; the
 * request follows it, and the code on the final URL says what happened.
 */
import type { PictureCode } from '../../src/account/picture-notes';
import { noteFor } from '../../src/account/picture-notes';
import { uploadOutcome } from '../../src/settings/picture-checks';

export type UploadResult =
  | { readonly kind: 'done'; readonly code: PictureCode }
  | { readonly kind: 'refused'; readonly code: PictureCode }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'aborted' };

export function sendPicture(request: {
  readonly action: string;
  readonly csrf: string;
  readonly picture: Blob;
  readonly onProgress: (fraction: number) => void;
  readonly signal: AbortSignal;
}): Promise<UploadResult> {
  const body = new FormData();
  body.set('csrf', request.csrf);
  body.set('file', request.picture, `picture.${extensionOf(request.picture.type)}`);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', request.action);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) request.onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => resolve(outcomeOf(xhr.responseURL)));
    xhr.addEventListener('error', () =>
      resolve({
        kind: 'failed',
        message: 'The upload did not finish. Check the connection and try again.',
      }),
    );
    xhr.addEventListener('abort', () => resolve({ kind: 'aborted' }));
    request.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

function outcomeOf(finalUrl: string): UploadResult {
  const code = uploadOutcome(finalUrl);
  if (code === null)
    return {
      kind: 'failed',
      message:
        'That picture could not be saved. Reload the page (you may need to sign in) and try again.',
    };
  return { kind: noteFor(code).kind === 'saved' ? 'done' : 'refused', code };
}

function extensionOf(type: string): string {
  if (type === 'image/webp') return 'webp';
  if (type === 'image/jpeg') return 'jpg';
  return 'png';
}
