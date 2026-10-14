'use client';

/**
 * Moving and zooming the picture in the crop dialog: one pointer drags (mouse, pen or a
 * finger), two pinch, the wheel zooms about the pointer, and the arrow keys and + / − do the
 * same from the keyboard. Every change goes through the pure crop math, so the frame stays
 * covered whatever the gesture.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, PointerEvent, RefObject, SetStateAction } from 'react';

import type { CropSubject, CropView, Point, Rect } from '../../src/settings/picture-crop';
import { panView, zoomView } from '../../src/settings/picture-crop';

/** Frame pixels an arrow key moves the picture; Shift moves it four times as far. */
const KEY_STEP = 10;
const KEY_ZOOM = 1.1;
/** Wheel delta to zoom factor: a typical notch (100) is about 16 percent. */
const WHEEL_RATE = 0.0015;

type Gesture = {
  readonly subject: CropSubject;
  readonly frame: Rect;
  readonly setView: Dispatch<SetStateAction<CropView>>;
  readonly isDisabled: boolean;
};

export type CropGestures = {
  readonly isMoving: boolean;
  readonly handlers: {
    readonly onPointerDown: (event: PointerEvent<HTMLCanvasElement>) => void;
    readonly onPointerMove: (event: PointerEvent<HTMLCanvasElement>) => void;
    readonly onPointerUp: (event: PointerEvent<HTMLCanvasElement>) => void;
    readonly onPointerCancel: (event: PointerEvent<HTMLCanvasElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => void;
  };
};

export function useCropGestures(
  canvas: RefObject<HTMLCanvasElement | null>,
  gesture: Gesture,
): CropGestures {
  const pointers = useRef(new Map<number, Point>());
  const [isMoving, setIsMoving] = useState(false);
  const latest = useRef(gesture);
  useLayoutEffect(() => {
    latest.current = gesture;
  });
  useWheelZoom(canvas, latest);

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const before = pointers.current;
    if (!before.has(event.pointerId) || gesture.isDisabled) return;
    const after = new Map(before).set(event.pointerId, stagePoint(event));
    pointers.current = after;
    gesture.setView((view) => moveBetween(gesture, view, { before, after }));
  };
  const release = (event: PointerEvent<HTMLCanvasElement>) => {
    const left = new Map(pointers.current);
    left.delete(event.pointerId);
    pointers.current = left;
    if (left.size === 0) setIsMoving(false);
  };
  return {
    isMoving,
    handlers: {
      onPointerDown: (event) => {
        if (gesture.isDisabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current = new Map(pointers.current).set(event.pointerId, stagePoint(event));
        setIsMoving(true);
      },
      onPointerMove,
      onPointerUp: release,
      onPointerCancel: release,
      onKeyDown: (event) => {
        const next = keyMove(gesture, event.key, event.shiftKey);
        if (next === null || gesture.isDisabled) return;
        event.preventDefault();
        gesture.setView(next);
      },
    },
  };
}

/** React's wheel listener is passive, so the page would scroll; this one is not. */
function useWheelZoom(
  canvas: RefObject<HTMLCanvasElement | null>,
  latest: RefObject<Gesture>,
): void {
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      const { subject, frame, setView, isDisabled } = latest.current;
      if (isDisabled) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const about = frameFraction(frame, {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
      const factor = Math.exp(-event.deltaY * WHEEL_RATE);
      setView((view) => zoomView(subject, view, { to: view.zoom * factor, about }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [canvas, latest]);
}

/** One pointer pans; two pinch about their midpoint and pan with it. */
function moveBetween(
  gesture: Gesture,
  view: CropView,
  pointers: {
    readonly before: ReadonlyMap<number, Point>;
    readonly after: ReadonlyMap<number, Point>;
  },
): CropView {
  const before = [...pointers.before.values()].slice(0, 2);
  const after = [...pointers.after.values()].slice(0, 2);
  const [first, second] = after;
  const [firstBefore, secondBefore] = before;
  if (first === undefined || firstBefore === undefined) return view;
  if (second === undefined || secondBefore === undefined)
    return panView(gesture.subject, view, {
      by: { x: first.x - firstBefore.x, y: first.y - firstBefore.y },
      frameWidth: gesture.frame.width,
    });
  const middle = midpoint(first, second);
  const middleBefore = midpoint(firstBefore, secondBefore);
  const spread = distance(first, second) / Math.max(1, distance(firstBefore, secondBefore));
  const zoomed = zoomView(gesture.subject, view, {
    to: view.zoom * spread,
    about: frameFraction(gesture.frame, middle),
  });
  return panView(gesture.subject, zoomed, {
    by: { x: middle.x - middleBefore.x, y: middle.y - middleBefore.y },
    frameWidth: gesture.frame.width,
  });
}

function keyMove(
  gesture: Gesture,
  key: string,
  isShifted: boolean,
): ((view: CropView) => CropView) | null {
  const step = isShifted ? KEY_STEP * 4 : KEY_STEP;
  const centre = { x: 0.5, y: 0.5 };
  const pan = (by: Point) => (view: CropView) =>
    panView(gesture.subject, view, { by, frameWidth: gesture.frame.width });
  const zoom = (factor: number) => (view: CropView) =>
    zoomView(gesture.subject, view, { to: view.zoom * factor, about: centre });
  switch (key) {
    case 'ArrowLeft':
      return pan({ x: -step, y: 0 });
    case 'ArrowRight':
      return pan({ x: step, y: 0 });
    case 'ArrowUp':
      return pan({ x: 0, y: -step });
    case 'ArrowDown':
      return pan({ x: 0, y: step });
    case '+':
    case '=':
      return zoom(KEY_ZOOM);
    case '-':
    case '_':
      return zoom(1 / KEY_ZOOM);
    default:
      return null;
  }
}

function stagePoint(event: PointerEvent<HTMLCanvasElement>): Point {
  const box = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
}

function frameFraction(frame: Rect, point: Point): Point {
  return { x: (point.x - frame.x) / frame.width, y: (point.y - frame.y) / frame.height };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
