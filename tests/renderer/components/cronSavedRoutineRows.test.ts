// ============================================================================
// savedRoutineRows 纯函数测试（N-ROLE-ROUTINE-RESTATE）：
// 保存成功定义 → what/when/result 三行；角色绑定判据；resultChannel 标签解析。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { ChannelAccount } from '@shared/contract/channel';
import type { CronJobDefinition } from '../../../src/shared/contract';
import {
  buildSavedRoutineRestateRows,
  isRoleBoundJob,
  resolveSavedRoutineChannelLabel,
  savedRoutineRoleId,
  type SavedRoutineRestateLabels,
} from '../../../src/renderer/components/features/cron/savedRoutineRows';

const labels: SavedRoutineRestateLabels = {
  what: '检查什么',
  when: '什么时候',
  result: '结果送到哪里',
  fallbackWhat: '按任务描述执行并整理结果',
  reviewInbox: '自动化审核收件箱',
  savedWhenEvent: '有新消息到达时',
  savedRolePrefix: '由 {role} 执行：',
};

function agentJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-1',
    runsOn: 'local',
    name: '每日巡检',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: '看一圈邮件并汇总重点', roleId: 'role-x' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const accounts: ChannelAccount[] = [
  { id: 'acc-1', type: 'feishu', name: '工作飞书' } as ChannelAccount,
  { id: 'acc-2', type: 'http-api', name: '备用通道' } as ChannelAccount,
];

const catalog = {
  accounts,
  conversationsByAccount: {
    'acc-1': { conversations: [{ id: 'chat-1', name: '项目群' }] },
    'acc-2': { conversations: [] },
  },
};

describe('isRoleBoundJob / savedRoutineRoleId', () => {
  it('agent + roleId 是角色绑定；roleId 空白不算', () => {
    expect(isRoleBoundJob(agentJob())).toBe(true);
    expect(isRoleBoundJob(agentJob({ action: { type: 'agent', agentType: 'default', prompt: 'p' } }))).toBe(false);
    expect(isRoleBoundJob(agentJob({ action: { type: 'agent', agentType: 'default', prompt: 'p', roleId: '   ' } }))).toBe(false);
  });

  it('role-wake 是角色绑定（roleId 必填）；shell/tool 不是', () => {
    expect(isRoleBoundJob(agentJob({
      action: { type: 'role-wake', roleId: 'role-x' },
      scheduleType: 'every',
      schedule: { type: 'every', interval: 1, unit: 'days' },
    }))).toBe(true);
    expect(isRoleBoundJob(agentJob({ action: { type: 'shell', command: 'echo ok' } }))).toBe(false);
  });

  it('savedRoutineRoleId 取动作里的 roleId，非角色动作给空串', () => {
    expect(savedRoutineRoleId(agentJob())).toBe('role-x');
    expect(savedRoutineRoleId(agentJob({
      action: { type: 'role-wake', roleId: 'role-y' },
      scheduleType: 'every',
      schedule: { type: 'every', interval: 1, unit: 'days' },
    }))).toBe('role-y');
    expect(savedRoutineRoleId(agentJob({ action: { type: 'shell', command: 'echo ok' } }))).toBe('');
  });
});

describe('resolveSavedRoutineChannelLabel', () => {
  it('未设置给空串（调用方落审核收件箱）', () => {
    expect(resolveSavedRoutineChannelLabel('', catalog)).toBe('');
  });

  it('目录命中账号且会话在目录：账号名 · 会话标题', () => {
    expect(resolveSavedRoutineChannelLabel('工作飞书:chat-1', catalog)).toBe('工作飞书 · 项目群');
  });

  it('会话不在目录（或账号没有会话目录）：只给账号名', () => {
    expect(resolveSavedRoutineChannelLabel('工作飞书:chat-404', catalog)).toBe('工作飞书');
    expect(resolveSavedRoutineChannelLabel('备用通道:chat-1', catalog)).toBe('备用通道');
  });

  it('账号已不在（unknown account）：给账号名一段，绝不透出原始 "<账号>:<会话id>" 串', () => {
    expect(resolveSavedRoutineChannelLabel('离职同事飞书:chat-1', catalog)).toBe('离职同事飞书');
  });

  it('accountKey 匹配账号 type 或名字（与表单字段同一口径）', () => {
    expect(resolveSavedRoutineChannelLabel('feishu:chat-1', catalog)).toBe('工作飞书 · 项目群');
  });
});

describe('buildSavedRoutineRestateRows', () => {
  it('agent+roleId：what 带角色前缀，when 是人话（非原始 cron 串），result 用解析标签', () => {
    const rows = buildSavedRoutineRestateRows({
      job: agentJob({ resultChannel: '工作飞书:chat-1' }),
      roleDisplayName: '小星',
      channelLabel: '工作飞书 · 项目群',
      labels,
    });
    expect(rows.map((row) => row.key)).toEqual(['what', 'when', 'result']);
    expect(rows[0].value).toBe('由 小星 执行：每日巡检');
    expect(rows[1].value).toBe('每天 09:00');
    expect(rows[1].value).not.toContain('*');
    expect(rows[2].value).toBe('工作飞书 · 项目群');
  });

  it('role-wake：无 prompt 时 what 回落到任务名，仍带角色前缀', () => {
    const rows = buildSavedRoutineRestateRows({
      job: agentJob({
        name: '小星主动性',
        action: { type: 'role-wake', roleId: 'role-x' },
        scheduleType: 'every',
        schedule: { type: 'every', interval: 1, unit: 'days' },
      }),
      roleDisplayName: '小星',
      channelLabel: '',
      labels,
    });
    expect(rows[0].value).toBe('由 小星 执行：小星主动性');
    expect(rows[1].value).toBe('每 1 天');
    expect(rows[2].value).toBe('自动化审核收件箱');
  });

  it('every / at / 复杂 cron 的人话 when（en 档按语言切换）', () => {
    const every = buildSavedRoutineRestateRows({
      job: agentJob({
        scheduleType: 'every',
        schedule: { type: 'every', interval: 2, unit: 'hours' },
      }),
      roleDisplayName: '小星',
      channelLabel: '',
      labels,
    });
    expect(every[1].value).toBe('每 2 小时');

    const at = buildSavedRoutineRestateRows({
      job: agentJob({
        scheduleType: 'at',
        schedule: { type: 'at', datetime: '2026-03-19T09:00:00' },
      }),
      roleDisplayName: '小星',
      channelLabel: '',
      labels,
    });
    expect(at[1].value).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);

    const complex = buildSavedRoutineRestateRows({
      job: agentJob({ schedule: { type: 'cron', expression: '7 9-17/2 * * 1,3' } }),
      roleDisplayName: '小星',
      channelLabel: '',
      labels,
    });
    expect(complex[1].value).toBe('自定义时间 · 7 9-17/2 * * 1,3');

    const enRows = buildSavedRoutineRestateRows({
      job: agentJob(),
      roleDisplayName: 'Nova',
      channelLabel: '',
      labels: {
        ...labels,
        savedRolePrefix: 'Run by {role}: ',
        savedWhenEvent: 'When a new message arrives',
      },
      lang: 'en',
    });
    expect(enRows[0].value).toBe('Run by Nova: 每日巡检');
    expect(enRows[1].value).toBe('Daily at 09:00');
  });

  it('event 调度（channel 与 connector:mail 源）when 是固定句子，绝不空行', () => {
    const channelEvent = buildSavedRoutineRestateRows({
      job: agentJob({
        scheduleType: 'event',
        schedule: { type: 'event', source: 'channel', accountId: 'acc-1', eventName: 'message' },
      }),
      roleDisplayName: '小星',
      channelLabel: '',
      labels,
    });
    expect(channelEvent[1].value).toBe('有新消息到达时');
    expect(channelEvent[1].value).not.toBe('');

    const mailEvent = buildSavedRoutineRestateRows({
      job: agentJob({
        scheduleType: 'event',
        schedule: { type: 'event', source: 'connector', connector: 'mail', accountId: '我的邮箱', eventName: 'message' },
      }),
      roleDisplayName: '小星',
      channelLabel: '',
      labels,
    });
    expect(mailEvent[1].value).toBe('有新消息到达时');
  });

  it('行内容跟随保存的记录：record 的 name 与调度是什么就显示什么', () => {
    const rows = buildSavedRoutineRestateRows({
      job: agentJob({
        name: '记录里的名字',
        schedule: { type: 'cron', expression: '30 8 * * 1-5' },
      }),
      roleDisplayName: '小星',
      channelLabel: '备用通道',
      labels,
    });
    expect(rows[0].value).toBe('由 小星 执行：记录里的名字');
    expect(rows[1].value).toBe('工作日 08:30');
    expect(rows[2].value).toBe('备用通道');
  });
});
