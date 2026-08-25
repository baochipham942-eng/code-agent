import { afterEach, describe, expect, it, vi } from 'vitest';

describe('today anchor consumers', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/shared/todayAnchor');
    vi.resetModules();
  });

  it('drives builder, web search, and cron dates from one mocked source', async () => {
    const anchor = {
      prompt: "Today's date: 2099-12-31 (Thursday).\nThe current year is 2099, not 2098 — treat this date as authoritative.",
      isoDate: '2099-12-31',
      year: 2099,
      month: 12,
      day: 31,
    };
    const formatTodayAnchor = vi.fn(() => anchor);
    vi.doMock('../../../src/shared/todayAnchor', () => ({ formatTodayAnchor }));

    const [{ buildPrompt }, { webSearchSchema }, { buildCronAgentPrompt }] = await Promise.all([
      import('../../../src/host/prompts/builder'),
      import('../../../src/host/tools/modules/network/webSearch.schema'),
      import('../../../src/host/cron/cronAgentPrompt'),
    ]);

    expect(buildPrompt()).toContain(anchor.prompt);
    expect(webSearchSchema.dynamicDescription?.()).toContain('2099年12月31日');
    expect(buildCronAgentPrompt('check', null, false, new Date('2026-08-25T00:00:00.000Z')))
      .toContain('今天本地日期是 2099-12-31');
    expect(formatTodayAnchor).toHaveBeenCalledTimes(3);
  });
});
