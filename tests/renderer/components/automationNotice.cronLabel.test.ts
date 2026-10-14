// FB-326：同一 cron 调度下，renderer 通知的 formatCronScheduleLabel 与 host 侧
// cronAutomationBridge.formatCronScheduleLabel 必须逐字一致（共用 shared/cronHumanize），
// 否则「自动化已创建」通知与自动化记录里的频率文案会各说各话。
import { describe, expect, it, vi } from 'vitest';
import type { CronScheduleConfig } from '../../../src/shared/contract';

// host 模块经 sessionAutomation 服务拖进 node-only 依赖，mock 掉再 import。
vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({}),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => null }),
}));
vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: vi.fn(),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession: vi.fn() }),
}));

import { formatCronScheduleLabel as hostLabel } from '../../../src/host/cron/cronAutomationBridge';
import { formatCronScheduleLabel as rendererLabel } from '../../../src/renderer/components/features/chat/automationNotice';

describe('automationNotice.formatCronScheduleLabel（与 host 一致）', () => {
  const cases: Array<[string, CronScheduleConfig]> = [
    ['17 8 * * * · Asia/Shanghai', { type: 'cron', expression: '17 8 * * *', timezone: 'Asia/Shanghai' }],
    ['30 8 * * *', { type: 'cron', expression: '30 8 * * *' }],
    ['0 9 * * 1-5', { type: 'cron', expression: '0 9 * * 1-5' }],
    ['30 17 * * 4', { type: 'cron', expression: '30 17 * * 4' }],
    ['0 9 1 * *', { type: 'cron', expression: '0 9 1 * *' }],
    ['*/15 * * * *', { type: 'cron', expression: '*/15 * * * *' }],
    ['0 */2 * * * · UTC', { type: 'cron', expression: '0 */2 * * *', timezone: 'UTC' }],
    ['0 9 1,15 * * · Asia/Shanghai', { type: 'cron', expression: '0 9 1,15 * *', timezone: 'Asia/Shanghai' }],
    ['every 3 hours', { type: 'every', interval: 3, unit: 'hours' }],
  ];

  it.each(cases)('%s → renderer 与 host 逐字一致', (_name, schedule) => {
    expect(rendererLabel(schedule)).toBe(hostLabel(schedule));
  });

  it('FB-326 例：17 8 * * * · Asia/Shanghai → 每天 08:17（不再是裸 cron 文本）', () => {
    expect(rendererLabel({ type: 'cron', expression: '17 8 * * *', timezone: 'Asia/Shanghai' })).toBe('每天 08:17');
    expect(hostLabel({ type: 'cron', expression: '17 8 * * *', timezone: 'Asia/Shanghai' })).toBe('每天 08:17');
  });
});
