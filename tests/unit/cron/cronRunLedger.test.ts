import { describe, expect, it } from 'vitest';
import { addCronRunCostUsd } from '../../../src/shared/cronRunLedger';

// 每日小计/唤醒 skip 解析的用例随 renderer 呈现单（N-CRON-RUN-LEDGER-VISIBLE-P2）回归。

describe('addCronRunCostUsd', () => {
  it('重试尝试累加到同一执行记录', () => {
    expect(addCronRunCostUsd(0.01, 0.02)).toBeCloseTo(0.03);
  });

  it('undefined 读数不覆盖已记账（重试簿记不冲销）', () => {
    expect(addCronRunCostUsd(0.01, undefined)).toBe(0.01);
  });

  it('首笔无读数保持 undefined（无模型调用 → dash）', () => {
    expect(addCronRunCostUsd(undefined, undefined)).toBeUndefined();
  });

  it('零/负读数不写入', () => {
    expect(addCronRunCostUsd(0.01, 0)).toBe(0.01);
    expect(addCronRunCostUsd(0.01, -1)).toBe(0.01);
  });
});
