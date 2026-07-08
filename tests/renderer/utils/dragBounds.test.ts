import { describe, expect, it } from 'vitest';
import { isDragPointInsideVisibleRect } from '../../../src/renderer/utils/dragBounds';

describe('dragBounds', () => {
  const rect = { left: 20, top: 80, right: 780, bottom: 680 };
  const viewport = { width: 800, height: 700 };

  it('accepts drag points inside the visible chat rect', () => {
    expect(isDragPointInsideVisibleRect({ clientX: 200, clientY: 200 }, rect, viewport)).toBe(true);
  });

  it('rejects drag points outside the chat rect or viewport', () => {
    expect(isDragPointInsideVisibleRect({ clientX: 790, clientY: 200 }, rect, viewport)).toBe(false);
    expect(isDragPointInsideVisibleRect({ clientX: 200, clientY: 690 }, rect, viewport)).toBe(false);
    expect(isDragPointInsideVisibleRect({ clientX: 0, clientY: 200 }, rect, viewport)).toBe(false);
    expect(isDragPointInsideVisibleRect({ clientX: 200, clientY: 700 }, rect, viewport)).toBe(false);
  });
});
