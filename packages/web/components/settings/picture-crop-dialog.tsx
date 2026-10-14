'use client';

/**
 * The crop dialog: a modal `<dialog>` (the page behind is inert, Escape and Cancel close it,
 * the opener gets focus back) with the chosen picture in its frame. Save draws the crop at
 * the output size and posts it to the upload route, so the server's checks still apply.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { PictureCode } from '../../src/account/picture-notes';
import { noteFor } from '../../src/account/picture-notes';
import type { CropSubject, CropView, PictureSpec } from '../../src/settings/picture-crop';
import { frameInStage, initialView, maxZoom, zoomView } from '../../src/settings/picture-crop';
import { drawStage, encodeCrop } from './picture-canvas';
import { sendPicture } from './picture-upload-request';
import styles from './picture-upload.module.css';
import { useCropGestures } from './use-crop-gestures';

/** A decoded picture, ready to crop. */
export type ChosenPicture = {
  readonly bitmap: ImageBitmap;
  readonly isAnimatable: boolean;
};

type Phase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'saving'; readonly progress: number }
  | { readonly kind: 'failed'; readonly message: string };

const WIDE_MARGIN = 24;
const NARROW_MARGIN = 14;
const NARROW_STAGE = 380;

export function PictureCropDialog(props: {
  readonly chosen: ChosenPicture;
  readonly spec: PictureSpec;
  readonly title: string;
  readonly upload: { readonly action: string; readonly csrf: string };
  readonly onSaved: (saved: { readonly picture: Blob; readonly code: PictureCode }) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const titleId = useId();
  const hintId = useId();
  const subject: CropSubject = {
    image: { width: props.chosen.bitmap.width, height: props.chosen.bitmap.height },
    aspect: props.spec.aspect,
  };
  const [view, setView] = useState<CropView>(() => initialView(subject));
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const stageWidth = useStageWidth(canvas);
  const margin = stageWidth < NARROW_STAGE ? NARROW_MARGIN : WIDE_MARGIN;
  const frame = frameInStage(stageWidth, margin, props.spec.aspect);
  const stageHeight = frame.height + 2 * margin;
  const isSaving = phase.kind === 'saving';
  const gestures = useCropGestures(canvas, { subject, frame, setView, isDisabled: isSaving });
  const aborter = useRef<AbortController | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    canvas.current?.focus({ focusVisible: false });
    return () => aborter.current?.abort();
  }, []);
  useEffect(() => {
    if (canvas.current === null || stageWidth === 0) return;
    drawStage(canvas.current, {
      bitmap: props.chosen.bitmap,
      subject,
      view,
      frame,
      size: { width: stageWidth, height: stageHeight },
      mask: props.spec.mask,
      isMoving: gestures.isMoving,
    });
  });

  const save = async () => {
    const controller = new AbortController();
    aborter.current = controller;
    setPhase({ kind: 'saving', progress: 0 });
    const picture = await encodeCrop(props.chosen.bitmap, {
      subject,
      view,
      output: props.spec.output,
    }).catch((error: unknown) => {
      if (error instanceof Error) return null;
      throw error;
    });
    if (picture === null) {
      setPhase({
        kind: 'failed',
        message: 'This browser could not prepare the picture. Try another image.',
      });
      return;
    }
    const result = await sendPicture({
      ...props.upload,
      picture,
      signal: controller.signal,
      onProgress: (progress) => setPhase({ kind: 'saving', progress }),
    });
    if (result.kind === 'done') {
      props.onSaved({ picture, code: result.code });
      dialog.current?.close();
    } else if (result.kind === 'refused') {
      setPhase({ kind: 'failed', message: noteFor(result.code).text });
    } else if (result.kind === 'failed') {
      setPhase({ kind: 'failed', message: result.message });
    }
  };
  const zoomTo = (zoom: number) =>
    setView((current) => zoomView(subject, current, { to: zoom, about: { x: 0.5, y: 0.5 } }));
  const limit = maxZoom(subject);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={hintId}
      onClose={props.onClose}
    >
      <h2 id={titleId} className={styles.dialogTitle}>
        {props.title}
      </h2>
      <p id={hintId} className={styles.dialogHint}>
        Drag to move it; zoom with the slider, the wheel or a pinch. Arrow keys move it too.
      </p>
      <div className={styles.stage} style={{ height: stageHeight || undefined }}>
        <canvas
          ref={canvas}
          className={styles.canvas}
          data-moving={gestures.isMoving ? '' : undefined}
          style={{ height: stageHeight || undefined }}
          tabIndex={0}
          role="img"
          aria-label="The picture in its frame"
          {...gestures.handlers}
        />
      </div>
      <div className={styles.zoomRow}>
        <button
          type="button"
          className={styles.zoomStep}
          aria-label="Zoom out"
          disabled={isSaving || view.zoom <= 1}
          onClick={() => zoomTo(view.zoom / 1.25)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8h9" />
          </svg>
        </button>
        <input
          type="range"
          className={styles.zoom}
          aria-label="Zoom"
          min={1}
          max={limit}
          step={0.01}
          value={view.zoom}
          disabled={isSaving || limit <= 1}
          onChange={(event) => zoomTo(event.currentTarget.valueAsNumber)}
        />
        <button
          type="button"
          className={styles.zoomStep}
          aria-label="Zoom in"
          disabled={isSaving || view.zoom >= limit}
          onClick={() => zoomTo(view.zoom * 1.25)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8h9M8 3.5v9" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.reset}
          disabled={isSaving}
          onClick={() => setView(initialView(subject))}
        >
          Reset
        </button>
      </div>
      {props.chosen.isAnimatable ? (
        <p className={styles.dialogHint}>A GIF is saved as a still picture: its first frame.</p>
      ) : null}
      <SaveLine phase={phase} />
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.cancel} onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.save}
          disabled={isSaving || stageWidth === 0}
          onClick={() => void save()}
        >
          {isSaving ? 'Saving…' : 'Save picture'}
        </button>
      </div>
    </dialog>
  );
}

function SaveLine({ phase }: { readonly phase: Phase }) {
  if (phase.kind === 'failed')
    return (
      <p className={styles.dialogError} role="alert">
        {phase.message}
      </p>
    );
  if (phase.kind === 'saving')
    return (
      <div className={styles.progress} role="status">
        <progress max={1} value={phase.progress} aria-label="Upload progress" />
        <span>
          {phase.progress < 1 ? `Uploading ${Math.round(phase.progress * 100)}%` : 'Saving…'}
        </span>
      </div>
    );
  return null;
}

/** The canvas's width in CSS pixels, following the dialog as the window resizes. */
function useStageWidth(canvas: RefObject<HTMLCanvasElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);
  return width;
}
