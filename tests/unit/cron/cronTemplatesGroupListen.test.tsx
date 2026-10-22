// ============================================================================
// 群监听模板（N-CRON-EVENT-CREATE-CHAT）—— 模板 → buildCronJobInput 的载荷契约：
// generate 拿编辑器注入的 accountId/chatId/budget（模板字段里不出现这三键，
// 用户看不到 Agent 类型或 JSON 档），产出 event 调度 + agent 动作 + 本机 + 预算；
// 预算缺省 0.5（owner 裁定），空账号过不了共享校验器（编辑器提交前已本地化拦截，
// 这里钉兜底链路）。i18n：zh/en 模板词条齐备（新模板文案一律走 i18n）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { CRON_EVENT_TRIGGER } from '../../../src/shared/constants/cronEventTrigger';
import { CRON_TEMPLATES } from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { cronCenterEn } from '../../../src/renderer/i18n/cronCenter';

const groupListen = CRON_TEMPLATES.find((template) => template.id === 'group-listen');

describe('group-listen template', () => {
  it('exists and is flagged as an event template with a single free-text field', () => {
    expect(groupListen).toBeDefined();
    expect(groupListen?.event).toBe(true);
    expect(groupListen?.fields.map((field) => field.key)).toEqual(['task']);
    expect(groupListen?.fields[0]?.type).toBe('textarea');
  });

  it('builds an event job payload from the one-liner plus injected bindings', () => {
    const draft = groupListen?.generate({
      task: '有人提到发布就总结给我',
      accountId: 'account-feishu',
      chatId: 'oc_release',
      budget: '0.5',
    });
    expect(draft).toBeDefined();
    const input = buildCronJobInput(draft!);
    expect(input.scheduleType).toBe('event');
    expect(input.schedule).toEqual({
      type: 'event', source: 'channel', eventName: 'message', accountId: 'account-feishu', chatId: 'oc_release',
    });
    expect(input.runsOn).toBe('local');
    expect(input.maxRunBudget).toBe(0.5);
    expect(input.action).toEqual({
      type: 'agent',
      agentType: 'default',
      prompt: '有人提到发布就总结给我',
      context: {},
      roleId: undefined,
      libraryProjectId: undefined,
      urgencyCriteria: undefined,
    });
  });

  it('defaults the budget to the shared constant and omits an empty chatId', () => {
    const draft = groupListen?.generate({ task: '总结群里提到的事', accountId: 'account-feishu' });
    const input = buildCronJobInput(draft!);
    expect(input.maxRunBudget).toBe(CRON_EVENT_TRIGGER.DEFAULT_RUN_BUDGET_USD);
    expect(input.maxRunBudget).toBe(0.5);
    expect(input.schedule).not.toHaveProperty('chatId');
    expect(input.schedule).toEqual({
      type: 'event', source: 'channel', eventName: 'message', accountId: 'account-feishu',
    });
  });

  it('still trips the shared validator without an account (belt and braces behind the editor gate)', () => {
    const draft = groupListen?.generate({ task: '总结群里提到的事', accountId: '', chatId: '', budget: '0.5' });
    expect(() => buildCronJobInput(draft!)).toThrow(/accountId must be a non-empty string/);
  });

  it('registers display copy in both zh and en template wordings', () => {
    expect(cronCenterZh.cronCenter.templates['group-listen']?.name).toBe('群监听');
    expect(cronCenterZh.cronCenter.templates['group-listen']?.description).toContain('群');
    expect(cronCenterEn.cronCenter.templates['group-listen']?.name).toBe('Group listen');
    expect(cronCenterEn.cronCenter.templates['group-listen']?.scheduleLabel).toBeTruthy();
  });
});
