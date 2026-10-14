'use client';

/**
 * One uploaded picture (a person's avatar, an org's icon, a repository's social image): the
 * current one, which also takes a dropped file, and one "Change" button that opens the crop
 * dialog. The form underneath is the plain multipart POST the route has always taken; with
 * scripts off it shows its file input and Upload button and works as before.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';

import type { PictureNote } from '../../src/account/picture-notes';
import { noteFor } from '../../src/account/picture-notes';
import {
  PICTURE_ACCEPT,
  fileRefusal,
  pictureType,
  sideRefusal,
} from '../../src/settings/picture-checks';
import type { PictureShape } from '../../src/settings/picture-crop';
import { PICTURE_SPECS } from '../../src/settings/picture-crop';
import type { ChosenPicture } from './picture-crop-dialog';
import { PictureCropDialog } from './picture-crop-dialog';
import styles from './picture-upload.module.css';

export function PictureUpload(props: {
  readonly shape: PictureShape;
  /** What the picture is called on buttons: "picture", "icon", "image". */
  readonly noun: string;
  /** The dialog's title, e.g. "Crop your picture". */
  readonly cropTitle: string;
  /** The route handler that takes `csrf` and `file`. */
  readonly action: string;
  readonly csrf: string;
  readonly current: ReactNode;
  readonly hasPicture: boolean;
  /** What the last upload did (`?picture=` on the page), or a remove action's outcome. */
  readonly note: PictureNote | null;
  /** The remove form, shown in the same row; null when there is nothing to remove. */
  readonly remove: ReactNode;
  readonly buttonClassName: string | undefined;
  readonly hint?: ReactNode;
}) {
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState<ChosenPicture | null>(null);
  const [preview, setPreview] = useBlobUrl();
  const [localNote, setLocalNote] = useState<PictureNote | null>(null);
  const [isDropping, setIsDropping] = useState(false);
  const note = localNote ?? props.note;
  const hasPicture = props.hasPicture || preview !== null;
  const verb = hasPicture ? 'Change' : 'Upload';

  const open = async (file: File | undefined) => {
    if (file === undefined) return;
    const opened = await openPicture(file);
    if (opened.kind === 'refused') {
      setLocalNote(opened.note);
      return;
    }
    setLocalNote(null);
    setChosen(opened.chosen);
  };
  const close = () => {
    chosen?.bitmap.close();
    setChosen(null);
    if (input.current !== null) input.current.value = '';
    opener.current?.focus();
  };
  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setIsDropping(true);
    },
    onDragLeave: () => setIsDropping(false),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropping(false);
      void open(event.dataTransfer.files[0]);
    },
  };

  return (
    <div className={`${styles.picture} ${styles[props.shape]}`}>
      <div className={styles.current} data-dropping={isDropping ? '' : undefined} {...dropHandlers}>
        {preview === null ? props.current : <PreviewImage shape={props.shape} src={preview} />}
        <span className={styles.dropLabel} aria-hidden="true">
          Drop to crop
        </span>
      </div>
      <div className={styles.side}>
        <div className={styles.row}>
          <form
            method="post"
            action={props.action}
            encType="multipart/form-data"
            className={styles.form}
          >
            <input type="hidden" name="csrf" value={props.csrf} />
            <label htmlFor={inputId} className="visually-hidden">
              {props.noun} file
            </label>
            <input
              ref={input}
              id={inputId}
              type="file"
              name="file"
              accept={PICTURE_ACCEPT}
              required
              className={styles.file}
              onChange={(event) => void open(event.currentTarget.files?.[0])}
            />
            <button
              type="submit"
              className={`${props.buttonClassName ?? ''} ${styles.plainSubmit}`}
            >
              Upload
            </button>
            <button
              ref={opener}
              type="button"
              className={`${props.buttonClassName ?? ''} ${styles.choose}`}
              aria-haspopup="dialog"
              onClick={() => input.current?.click()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.chooseIcon}>
                <path d="M2.5 11.5v2h11v-2M8 10.5V2.5M4.75 5.5 8 2.25l3.25 3.25" />
              </svg>
              {verb} {props.noun}
            </button>
          </form>
          {props.remove}
        </div>
        {props.hint === undefined ? null : <p className={styles.hint}>{props.hint}</p>}
        {note === null ? null : (
          <p
            className={note.kind === 'error' ? styles.error : styles.saved}
            role={note.kind === 'error' ? 'alert' : 'status'}
          >
            {note.text}
          </p>
        )}
      </div>
      {chosen === null ? null : (
        <PictureCropDialog
          chosen={chosen}
          spec={PICTURE_SPECS[props.shape]}
          title={props.cropTitle}
          upload={{ action: props.action, csrf: props.csrf }}
          onClose={close}
          onSaved={({ picture, code }) => {
            setPreview(picture);
            setLocalNote(noteFor(code));
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function PreviewImage({ shape, src }: { readonly shape: PictureShape; readonly src: string }) {
  const { output } = PICTURE_SPECS[shape];
  const scale = shape === 'social' ? 420 / output.width : 96 / output.width;
  return (
    <img
      className={styles.preview}
      src={src}
      alt="The picture you just saved"
      width={Math.round(output.width * scale)}
      height={Math.round(output.height * scale)}
    />
  );
}

type Opened =
  | { readonly kind: 'chosen'; readonly chosen: ChosenPicture }
  | { readonly kind: 'refused'; readonly note: PictureNote };

/** Checks the file as the server would, then decodes it (a GIF's first frame). */
async function openPicture(file: File): Promise<Opened> {
  const refusal = fileRefusal(file);
  if (refusal !== null) return { kind: 'refused', note: noteFor(refusal) };
  const bitmap = await createImageBitmap(file).catch((error: unknown) => {
    // An undecodable file rejects with a DOMException (an Error in every current browser).
    if (error instanceof DOMException || error instanceof Error) return null;
    throw error;
  });
  if (bitmap === null) return { kind: 'refused', note: noteFor('corrupt') };
  const tooSmallOrBig = sideRefusal(bitmap);
  if (tooSmallOrBig !== null) {
    bitmap.close();
    return { kind: 'refused', note: noteFor(tooSmallOrBig) };
  }
  return { kind: 'chosen', chosen: { bitmap, isAnimatable: pictureType(file) === 'image/gif' } };
}

/** An object URL for the last saved picture, revoked when replaced or unmounted. */
function useBlobUrl(): [string | null, (blob: Blob) => void] {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => (url === null ? undefined : () => URL.revokeObjectURL(url)), [url]);
  return [url, (blob) => setUrl(URL.createObjectURL(blob))];
}
