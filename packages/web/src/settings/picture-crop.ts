/**
 * The crop math behind the picture dialog, kept free of the DOM so it can be tested: a view
 * is a zoom and the frame's centre in image pixels, and every operation returns a view that
 * keeps the frame covered by the image (no empty space ever shows inside the frame).
 */

/** The three pictures people upload; each has its own frame and output size. */
export type PictureShape = 'avatar' | 'icon' | 'social';

export type Size = { readonly width: number; readonly height: number };
export type Point = { readonly x: number; readonly y: number };
export type Rect = Point & Size;

export type PictureSpec = {
  /** Frame width over height. */
  readonly aspect: number;
  /** The pixels the crop is drawn at before upload (the server's largest stored size). */
  readonly output: Size;
  /** Avatars show as circles, so the dialog masks the frame to one. */
  readonly mask: 'circle' | 'square';
};

export const PICTURE_SPECS: Readonly<Record<PictureShape, PictureSpec>> = {
  avatar: { aspect: 1, output: { width: 460, height: 460 }, mask: 'circle' },
  icon: { aspect: 1, output: { width: 460, height: 460 }, mask: 'square' },
  social: { aspect: 2, output: { width: 1280, height: 640 }, mask: 'square' },
};

/** The image being cropped and the frame's aspect. */
export type CropSubject = { readonly image: Size; readonly aspect: number };

/** Where the frame looks: 1 is the largest crop that fits, and the frame's centre in image pixels. */
export type CropView = { readonly zoom: number; readonly center: Point };

/** Zooming stops at eight times, or earlier when the crop would be under 16 image pixels. */
const MAX_ZOOM = 8;
const MIN_CROP_SIDE = 16;

/** The whole image's largest crop, centred. */
export function initialView(subject: CropSubject): CropView {
  return { zoom: 1, center: { x: subject.image.width / 2, y: subject.image.height / 2 } };
}

/** How far in this image can be zoomed (never below 1). */
export function maxZoom(subject: CropSubject): number {
  const base = largestCrop(subject);
  return Math.max(1, Math.min(MAX_ZOOM, Math.min(base.width, base.height) / MIN_CROP_SIDE));
}

/** The part of the image inside the frame, in image pixels. */
export function cropRect(subject: CropSubject, view: CropView): Rect {
  const base = largestCrop(subject);
  const width = base.width / view.zoom;
  const height = base.height / view.zoom;
  return { x: view.center.x - width / 2, y: view.center.y - height / 2, width, height };
}

/** The nearest view whose zoom is in range and whose crop lies inside the image. */
export function clampView(subject: CropSubject, view: CropView): CropView {
  const zoom = clamp(view.zoom, 1, maxZoom(subject));
  const base = largestCrop(subject);
  const halfWidth = base.width / zoom / 2;
  const halfHeight = base.height / zoom / 2;
  return {
    zoom,
    center: {
      x: clamp(view.center.x, halfWidth, subject.image.width - halfWidth),
      y: clamp(view.center.y, halfHeight, subject.image.height - halfHeight),
    },
  };
}

/**
 * The view after the image is dragged `by` frame pixels (right and down are positive) in a
 * frame `frameWidth` pixels wide: the image follows the pointer, so the crop moves the other way.
 */
export function panView(
  subject: CropSubject,
  view: CropView,
  move: { readonly by: Point; readonly frameWidth: number },
): CropView {
  const imagePerFramePixel = cropRect(subject, view).width / move.frameWidth;
  return clampView(subject, {
    zoom: view.zoom,
    center: {
      x: view.center.x - move.by.x * imagePerFramePixel,
      y: view.center.y - move.by.y * imagePerFramePixel,
    },
  });
}

/**
 * The view at zoom `to`, keeping the image point under `about` still. `about` is a fraction
 * of the frame (0,0 its top left, 1,1 its bottom right; the pointer or the pinch's midpoint).
 */
export function zoomView(
  subject: CropSubject,
  view: CropView,
  zoom: { readonly to: number; readonly about: Point },
): CropView {
  const before = cropRect(subject, view);
  const anchor = {
    x: before.x + zoom.about.x * before.width,
    y: before.y + zoom.about.y * before.height,
  };
  const to = clamp(zoom.to, 1, maxZoom(subject));
  const after = cropRect(subject, { zoom: to, center: view.center });
  const left = anchor.x - zoom.about.x * after.width;
  const top = anchor.y - zoom.about.y * after.height;
  return clampView(subject, {
    zoom: to,
    center: { x: left + after.width / 2, y: top + after.height / 2 },
  });
}

/** Where the whole image is drawn so that the view's crop exactly fills `frame`. */
export function imagePlacement(subject: CropSubject, view: CropView, frame: Rect): Rect {
  const crop = cropRect(subject, view);
  const scale = frame.width / crop.width;
  return {
    x: frame.x - crop.x * scale,
    y: frame.y - crop.y * scale,
    width: subject.image.width * scale,
    height: subject.image.height * scale,
  };
}

/** The source and destination rectangles for drawing the crop at the output size. */
export function outputDraw(
  subject: CropSubject,
  view: CropView,
  output: Size,
): { readonly source: Rect; readonly target: Rect } {
  return {
    source: cropRect(subject, clampView(subject, view)),
    target: { x: 0, y: 0, width: output.width, height: output.height },
  };
}

/** The frame inside a stage `stageWidth` pixels wide with `margin` on every side. */
export function frameInStage(stageWidth: number, margin: number, aspect: number): Rect {
  const width = Math.max(1, stageWidth - 2 * margin);
  return { x: margin, y: margin, width, height: width / aspect };
}

function largestCrop(subject: CropSubject): Size {
  const { image, aspect } = subject;
  return image.width / image.height > aspect
    ? { width: image.height * aspect, height: image.height }
    : { width: image.width, height: image.width / aspect };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}
