/**
 * The crop dialog's canvas work: drawing the stage (the image, dimmed outside the frame) and
 * drawing the crop at the output size, encoded for upload. The geometry comes from the pure
 * `src/settings/picture-crop.ts`.
 */
import { MAX_IMAGE_BYTES } from '@gitstalk/shared-media/images';

import type {
  CropSubject,
  CropView,
  PictureSpec,
  Rect,
  Size,
} from '../../src/settings/picture-crop';
import { imagePlacement, outputDraw } from '../../src/settings/picture-crop';

export type Stage = {
  readonly bitmap: ImageBitmap;
  readonly subject: CropSubject;
  readonly view: CropView;
  readonly frame: Rect;
  /** CSS pixels; the canvas backing store is this times the device pixel ratio. */
  readonly size: Size;
  readonly mask: PictureSpec['mask'];
  readonly isMoving: boolean;
};

const SHADE = 'rgba(4, 7, 10, 0.62)';
const EDGE = 'rgba(255, 255, 255, 0.92)';
const GUIDE = 'rgba(255, 255, 255, 0.38)';

/** Draws the stage into `canvas`, resizing its backing store to the device's pixels. */
export function drawStage(canvas: HTMLCanvasElement, stage: Stage): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(stage.size.width * ratio);
  const height = Math.round(stage.size.height * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, stage.size.width, stage.size.height);
  context.imageSmoothingQuality = 'high';
  const placed = imagePlacement(stage.subject, stage.view, stage.frame);
  context.drawImage(stage.bitmap, placed.x, placed.y, placed.width, placed.height);
  shadeOutside(context, stage);
  if (stage.isMoving) drawGuides(context, stage.frame);
  outlineFrame(context, stage);
}

/**
 * The crop at the output size: WebP where the browser can encode it, else PNG, else JPEG when
 * PNG would be over the upload limit (a photo at 1280 × 640 can be).
 */
export async function encodeCrop(
  bitmap: ImageBitmap,
  crop: { readonly subject: CropSubject; readonly view: CropView; readonly output: Size },
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = crop.output.width;
  canvas.height = crop.output.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas 2d context unavailable');
  context.imageSmoothingQuality = 'high';
  const { source, target } = outputDraw(crop.subject, crop.view, crop.output);
  context.drawImage(
    bitmap,
    source.x,
    source.y,
    source.width,
    source.height,
    target.x,
    target.y,
    target.width,
    target.height,
  );
  const webp = await toBlob(canvas, 'image/webp', 0.9);
  if (webp.type === 'image/webp') return webp;
  const png = await toBlob(canvas, 'image/png');
  return png.size <= MAX_IMAGE_BYTES ? png : toBlob(canvas, 'image/jpeg', 0.9);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error(`could not encode ${type}`)) : resolve(blob)),
      type,
      quality,
    );
  });
}

function framePath(context: CanvasRenderingContext2D, stage: Stage): void {
  const { frame } = stage;
  if (stage.mask === 'circle') {
    context.moveTo(frame.x + frame.width, frame.y + frame.height / 2);
    context.arc(
      frame.x + frame.width / 2,
      frame.y + frame.height / 2,
      frame.width / 2,
      0,
      Math.PI * 2,
    );
  } else {
    context.rect(frame.x, frame.y, frame.width, frame.height);
  }
}

function shadeOutside(context: CanvasRenderingContext2D, stage: Stage): void {
  context.beginPath();
  context.rect(0, 0, stage.size.width, stage.size.height);
  framePath(context, stage);
  context.fillStyle = SHADE;
  context.fill('evenodd');
}

function outlineFrame(context: CanvasRenderingContext2D, stage: Stage): void {
  context.beginPath();
  framePath(context, stage);
  context.lineWidth = 1.5;
  context.strokeStyle = EDGE;
  context.stroke();
}

/** Thirds while the picture moves, to line a face or a logo up. */
function drawGuides(context: CanvasRenderingContext2D, frame: Rect): void {
  context.beginPath();
  for (const third of [1 / 3, 2 / 3]) {
    context.moveTo(frame.x + frame.width * third, frame.y);
    context.lineTo(frame.x + frame.width * third, frame.y + frame.height);
    context.moveTo(frame.x, frame.y + frame.height * third);
    context.lineTo(frame.x + frame.width, frame.y + frame.height * third);
  }
  context.lineWidth = 1;
  context.strokeStyle = GUIDE;
  context.stroke();
}
