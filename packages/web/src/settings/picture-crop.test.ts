import { describe, expect, it } from 'vitest';

import { noteFor } from '../account/picture-notes';
import { fileRefusal, sideRefusal, uploadOutcome } from './picture-checks';
import {
  PICTURE_SPECS,
  clampView,
  cropRect,
  frameInStage,
  imagePlacement,
  initialView,
  maxZoom,
  outputDraw,
  panView,
  zoomView,
} from './picture-crop';
import type { CropSubject, CropView, Rect } from './picture-crop';

const wide: CropSubject = { image: { width: 1200, height: 800 }, aspect: 1 };
const tall: CropSubject = { image: { width: 600, height: 1800 }, aspect: 1 };
const banner: CropSubject = { image: { width: 1000, height: 1000 }, aspect: 2 };

/** The frame shows no empty space when the crop lies inside the image. */
function isCovered(subject: CropSubject, crop: Rect): boolean {
  const slack = 1e-6;
  return (
    crop.x >= -slack &&
    crop.y >= -slack &&
    crop.x + crop.width <= subject.image.width + slack &&
    crop.y + crop.height <= subject.image.height + slack
  );
}

describe('the starting crop', () => {
  it('is the largest centred square of a wide image', () => {
    expect(cropRect(wide, initialView(wide))).toEqual({ x: 200, y: 0, width: 800, height: 800 });
  });

  it('is the largest centred square of a tall image', () => {
    expect(cropRect(tall, initialView(tall))).toEqual({ x: 0, y: 600, width: 600, height: 600 });
  });

  it('is the largest centred 2:1 band of a square image for a social image', () => {
    expect(cropRect(banner, initialView(banner))).toEqual({
      x: 0,
      y: 250,
      width: 1000,
      height: 500,
    });
  });
});

describe('moving the picture', () => {
  it('moves the crop the opposite way to the drag, in image pixels', () => {
    const moved = panView(wide, initialView(wide), { by: { x: 40, y: 0 }, frameWidth: 400 });
    expect(cropRect(wide, moved).x).toBe(120);
  });

  it('stops at the image edge instead of showing empty space', () => {
    const moved = panView(wide, initialView(wide), { by: { x: 5000, y: -5000 }, frameWidth: 400 });
    expect(cropRect(wide, moved)).toEqual({ x: 0, y: 0, width: 800, height: 800 });
  });
});

describe('zooming', () => {
  it('keeps the image point under the pointer still', () => {
    const start: CropView = { zoom: 2, center: { x: 600, y: 400 } };
    const about = { x: 0.25, y: 0.75 };
    const before = cropRect(wide, start);
    const after = cropRect(wide, zoomView(wide, start, { to: 3, about }));
    expect(after.x + about.x * after.width).toBeCloseTo(before.x + about.x * before.width);
    expect(after.y + about.y * after.height).toBeCloseTo(before.y + about.y * before.height);
  });

  it('never zooms out past the largest crop', () => {
    expect(zoomView(wide, initialView(wide), { to: 0.2, about: { x: 0.5, y: 0.5 } }).zoom).toBe(1);
  });

  it('stops at eight times, or where the crop would be under 16 pixels', () => {
    expect(maxZoom(wide)).toBe(8);
    expect(maxZoom({ image: { width: 64, height: 64 }, aspect: 1 })).toBe(4);
    expect(maxZoom({ image: { width: 16, height: 16 }, aspect: 1 })).toBe(1);
  });

  it('pulls the crop back inside the image when zooming out near an edge', () => {
    const corner = clampView(wide, { zoom: 4, center: { x: 0, y: 0 } });
    const out = zoomView(wide, corner, { to: 1, about: { x: 0, y: 0 } });
    expect(cropRect(wide, out)).toEqual({ x: 0, y: 0, width: 800, height: 800 });
  });
});

describe('any sequence of moves and zooms', () => {
  it('keeps the frame covered', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    for (const subject of [wide, tall, banner]) {
      let view = initialView(subject);
      for (let step = 0; step < 500; step += 1) {
        view =
          next() < 0.5
            ? panView(subject, view, {
                by: { x: (next() - 0.5) * 900, y: (next() - 0.5) * 900 },
                frameWidth: 320,
              })
            : zoomView(subject, view, { to: next() * 10, about: { x: next(), y: next() } });
        expect(isCovered(subject, cropRect(subject, view))).toBe(true);
      }
    }
  });
});

describe('drawing', () => {
  it('places the image so the crop fills the frame', () => {
    const frame = frameInStage(440, 20, 1);
    expect(frame).toEqual({ x: 20, y: 20, width: 400, height: 400 });
    expect(imagePlacement(wide, initialView(wide), frame)).toEqual({
      x: -80,
      y: 20,
      width: 600,
      height: 400,
    });
  });

  it('maps the crop to the output size for upload', () => {
    const view = clampView(banner, { zoom: 2, center: { x: 250, y: 125 } });
    expect(outputDraw(banner, view, PICTURE_SPECS.social.output)).toEqual({
      source: { x: 0, y: 0, width: 500, height: 250 },
      target: { x: 0, y: 0, width: 1280, height: 640 },
    });
  });
});

const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('checks before the dialog opens', () => {
  it('takes the four image types, by type or by extension', () => {
    expect(fileRefusal(file('a.png', 'image/png'))).toBeNull();
    expect(fileRefusal(file('a.webp', ''))).toBeNull();
    expect(fileRefusal(file('a.gif', 'image/gif'))).toBeNull();
  });

  it('refuses SVG, other types, empty and over-2 MB files with the server wording', () => {
    expect(fileRefusal(file('a.svg', 'image/svg+xml'))).toBe('svg');
    expect(fileRefusal(file('a.heic', 'image/heic'))).toBe('unsupported_type');
    expect(fileRefusal(file('a.png', 'image/png', 0))).toBe('empty');
    expect(fileRefusal(file('a.png', 'image/png', 2 * 1024 * 1024 + 1))).toBe('too_large');
    expect(noteFor('too_large').text).toBe('Images can be up to 2 MB. Pick a smaller one.');
  });

  it('refuses images under 16 or over 4096 pixels a side', () => {
    expect(sideRefusal({ width: 15, height: 400 })).toBe('too_small');
    expect(sideRefusal({ width: 4097, height: 400 })).toBe('too_big');
    expect(sideRefusal({ width: 4096, height: 16 })).toBeNull();
  });

  it('reads what an upload did from the page its redirect ended on', () => {
    expect(uploadOutcome('https://gitstalk.io/settings?picture=updated')).toBe('updated');
    expect(uploadOutcome('https://gitstalk.io/sign-in')).toBeNull();
    expect(uploadOutcome('')).toBeNull();
  });
});
