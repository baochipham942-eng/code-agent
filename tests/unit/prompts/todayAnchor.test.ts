import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DYNAMIC_BOUNDARY_MARKER } from '../../../src/host/prompts/cacheBreakDetection';
import { formatTodayAnchor } from '../../../src/shared/todayAnchor';

describe('today prompt anchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds the fixed current date and authoritative year to the system prompt', async () => {
    const { buildPrompt } = await import('../../../src/host/prompts/builder');
    const prompt = buildPrompt();

    expect(prompt).toContain('2026-08-25');
    expect(prompt).toMatch(/当前年份是 2026，不是 2025|The current year is 2026, not 2025/);
  });

  it('places the date anchor before the dynamic boundary marker', async () => {
    const { buildPrompt } = await import('../../../src/host/prompts/builder');
    const prompt = buildPrompt();
    const anchor = formatTodayAnchor();

    expect(prompt.indexOf(anchor.prompt)).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(anchor.prompt)).toBeLessThan(prompt.indexOf(DYNAMIC_BOUNDARY_MARKER));
  });

  it('formats equivalent English and Chinese anchors in the user timezone', () => {
    const now = new Date('2026-08-25T00:30:00.000Z');

    expect(formatTodayAnchor(now, 'Asia/Shanghai', 'en').prompt).toBe(
      "Today's date: 2026-08-25 (Tuesday).\nThe current year is 2026, not 2025 — treat this date as authoritative.",
    );
    expect(formatTodayAnchor(now, 'Asia/Shanghai', 'zh').prompt).toBe(
      '今天的日期：2026-08-25（星期二）。\n当前年份是 2026，不是 2025；请将此日期视为权威信息。',
    );
  });
});
