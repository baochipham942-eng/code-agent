import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryCostBucket } from '../../../src/shared/contract/telemetry';

const storeState = vi.hoisted(() => ({
  costBuckets: [] as TelemetryCostBucket[],
  loadCostByPeriod: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/telemetryStore', () => ({
  useTelemetryStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

import { CostCalendar } from '../../../src/renderer/components/features/telemetry/CostCalendar';

function render(): string {
  return renderToStaticMarkup(React.createElement(CostCalendar, { userScope: {} }));
}

describe('CostCalendar 成本日历 UI（#16）', () => {
  it('有数据时渲染标题、日/周/月切换、区间汇总', () => {
    storeState.costBuckets = [
      { period: '2026-06-15', cost: 0.5, tokens: 1000, sessions: 2 },
      { period: '2026-06-16', cost: 0.3, tokens: 800, sessions: 1 },
    ];
    const markup = render();
    expect(markup).toContain('成本日历');
    expect(markup).toContain('日');
    expect(markup).toContain('周');
    expect(markup).toContain('月');
    // 区间总成本 = 0.8
    expect(markup).toContain('$0.80');
    expect(markup).toContain('3 会话');
  });

  it('无数据时显示空态', () => {
    storeState.costBuckets = [];
    const markup = render();
    expect(markup).toContain('该区间暂无成本数据');
  });
});
