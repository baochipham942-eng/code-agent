// ============================================================================
// formatDateTime 语言感知档（N-CRON-DETAIL-TIME-FORMAT-MIXED / FB-567+FB-570）：
// zh 固定 24 小时制 `YYYY/MM/DD HH:mm`（手工拼，不跟机器 locale 走）；
// en 维持 en-US 原样。与 cronRunListTime.test.ts 同层，钉详情页时间口径。
// N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1：实现迁到 src/renderer/utils/formatDateTime.ts
// 供全 renderer 复用，钉的还是同一个函数。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';
import { formatScheduleSummary } from '../../../src/renderer/components/features/cron/types';
import { formatDateTime } from '../../../src/renderer/utils/formatDateTime';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const AT = new Date(2026, 10, 9, 4, 0, 0).getTime(); // 2026-11-09 04:00
const PM = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05

describe('formatDateTime (detail time, language-aware)', () => {
  it('zh：24 小时制、带年份、零填充，不跟机器 locale 走', () => {
    expect(formatDateTime(AT, 'zh')).toBe('2026/11/09 04:00');
    // 下午 4 点显示 16:05，不是 4:05 PM
    expect(formatDateTime(PM, 'zh')).toBe('2026/11/09 16:05');
  });

  it('zh：ISO 字符串与同一瞬间的毫秒数给出同一文本', () => {
    expect(formatDateTime(new Date(AT).toISOString(), 'zh')).toBe(formatDateTime(AT, 'zh'));
  });

  it('zh：Date 实例入参同样成立（非 cron 屏复用时传 Date）', () => {
    expect(formatDateTime(new Date(PM), 'zh')).toBe('2026/11/09 16:05');
  });

  it('缺省 lang 等于 zh（调用方不传时也绝不落入机器 locale）', () => {
    expect(formatDateTime(AT)).toBe('2026/11/09 04:00');
  });

  it('en：维持 en-US 原样（英文 UI 行为不变）', () => {
    expect(formatDateTime(AT, 'en')).toBe('11/9/2026, 4:00:00 AM');
    expect(formatDateTime(PM, 'en')).toBe('11/9/2026, 4:05:00 PM');
  });

  it('兜底文案保留：未设置 / 无效时间', () => {
    expect(formatDateTime(undefined, 'zh')).toBe('未设置');
    expect(formatDateTime('not-a-date', 'zh')).toBe('无效时间');
    expect(formatDateTime(undefined, 'en')).toBe('未设置');
    expect(formatDateTime('not-a-date', 'en')).toBe('无效时间');
  });

  it('formatScheduleSummary 一次性档把 lang 传进时间（zh/en 各自口径）', () => {
    const job: CronJobDefinition = {
      id: 'job-at',
      runsOn: 'local',
      name: 'At job',
      scheduleType: 'at',
      schedule: { type: 'at', datetime: AT },
      action: { type: 'shell', command: 'echo ok' },
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(formatScheduleSummary(job, 'zh')).toBe('一次性 · 2026/11/09 04:00');
    expect(formatScheduleSummary(job, 'en')).toBe('一次性 · 11/9/2026, 4:00:00 AM');
  });
});
