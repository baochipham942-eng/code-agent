import { describe, expect, it } from 'vitest';
import {
  computeBashPreviewLines,
  BASH_PREVIEW_LINES_COMPLETED,
} from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/bashOutputPreview';

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');
}

describe('computeBashPreviewLines — completed long output', () => {
  it('keeps head + tail and drops the middle when over the budget', () => {
    const input = lines(100);
    const { displayLines, omittedCount } = computeBashPreviewLines(input, false);

    const headCount = Math.max(1, Math.floor(BASH_PREVIEW_LINES_COMPLETED * 0.2)); // 4
    const tailCount = BASH_PREVIEW_LINES_COMPLETED - headCount; // 16
    expect(omittedCount).toBe(100 - headCount - tailCount); // 80

    // 头部上下文
    expect(displayLines.slice(0, headCount)).toEqual(['line1', 'line2', 'line3', 'line4']);
    // 中段省略标记
    expect(displayLines[headCount]).toBe(`…省略 ${omittedCount} 行…`);
    // 尾部最终结果（旧实现会把这些全丢掉）
    expect(displayLines[displayLines.length - 1]).toBe('line100');
    expect(displayLines).toContain('line85'); // 100 - 16 + 1
  });

  it('shows everything untouched when within budget', () => {
    const input = lines(10);
    const { displayLines, omittedCount } = computeBashPreviewLines(input, false);
    expect(omittedCount).toBe(0);
    expect(displayLines).toHaveLength(10);
    expect(displayLines.join('\n')).toBe(input);
  });
});

describe('computeBashPreviewLines — pending', () => {
  it('shows only the last few lines for a streaming feel and reports the omitted count', () => {
    const { displayLines, omittedCount } = computeBashPreviewLines(lines(30), true);
    expect(omittedCount).toBe(25);
    expect(displayLines).toEqual(['line26', 'line27', 'line28', 'line29', 'line30']);
  });

  it('reports zero omitted when within the pending budget', () => {
    const { displayLines, omittedCount } = computeBashPreviewLines(lines(3), true);
    expect(omittedCount).toBe(0);
    expect(displayLines).toEqual(['line1', 'line2', 'line3']);
  });
});

describe('computeBashPreviewLines — progress frame folding', () => {
  it('collapses carriage-return progress frames to the final frame', () => {
    const input = 'Building...\rProgress: 10%\rProgress: 50%\rProgress: 100%';
    const { displayLines } = computeBashPreviewLines(input, true);
    expect(displayLines).toEqual(['Progress: 100%']);
  });

  it('applies backspaces within a folded line', () => {
    const input = 'loading123\b\b\bdone';
    const { displayLines } = computeBashPreviewLines(input, true);
    expect(displayLines).toEqual(['loadingdone']);
  });

  it('folds per-line so multi-line output keeps its real lines', () => {
    const input = 'step1: 0%\rstep1: 100%\nstep2: 0%\rstep2: 100%';
    const { displayLines } = computeBashPreviewLines(input, false);
    expect(displayLines).toEqual(['step1: 100%', 'step2: 100%']);
  });
});
