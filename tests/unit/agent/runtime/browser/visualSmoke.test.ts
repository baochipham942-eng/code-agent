import { describe, expect, it } from 'vitest';
import {
  hasGameCanvasAspectRatioMismatch,
  isPrimaryGameCanvasUndersizedForViewport,
} from '../../../../../src/main/agent/runtime/browser/visualSmoke';

describe('browser visual smoke layout heuristics', () => {
  it('flags fixed small game canvases on wide desktop previews', () => {
    expect(isPrimaryGameCanvasUndersizedForViewport([
      { width: 800, height: 600, visibleRatio: 1 },
    ], { width: 1920, height: 1080 })).toBe(true);
  });

  it('accepts canvases that use either wide or tall preview space', () => {
    expect(isPrimaryGameCanvasUndersizedForViewport([
      { width: 1500, height: 844, visibleRatio: 1 },
    ], { width: 1920, height: 1080 })).toBe(false);

    expect(isPrimaryGameCanvasUndersizedForViewport([
      { width: 640, height: 940, visibleRatio: 1 },
    ], { width: 1920, height: 1080 })).toBe(false);
  });

  it('flags game canvases whose rendered aspect ratio distorts the internal buffer', () => {
    expect(hasGameCanvasAspectRatioMismatch([
      { width: 484, height: 363, visibleRatio: 1, internalWidth: 480, internalHeight: 640 },
    ])).toBe(true);

    expect(hasGameCanvasAspectRatioMismatch([
      { width: 960, height: 540, visibleRatio: 1, internalWidth: 1920, internalHeight: 1080 },
    ])).toBe(false);
  });
});
