import { describe, expect, it } from 'vitest';
import {
  CRON_TEMPLATES,
  FEATURED_CRON_TEMPLATES,
  getTemplateDisplayCopy,
  type CronTemplate,
} from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

function template(id: string): CronTemplate {
  const t = CRON_TEMPLATES.find((tpl) => tpl.id === id);
  if (!t) throw new Error(`template ${id} not found`);
  return t;
}

describe('晨间分诊模板（morning-triage）', () => {
  it('在模板表里且进推荐位，字段形状与现有模板一致', () => {
    const t = template('morning-triage');
    expect(t.name).toBe('晨间分诊');
    expect(typeof t.emoji).toBe('string');
    expect(typeof t.description).toBe('string');
    expect(typeof t.scheduleLabel).toBe('string');
    expect(t.fields).toEqual([]);
    expect(typeof t.generate).toBe('function');
    expect(FEATURED_CRON_TEMPLATES.map((tpl) => tpl.id)).toContain('morning-triage');
  });

  it('无必填字段，生成 agent 任务：工作日 08:30、时区取本机本地时区', () => {
    const t = template('morning-triage');
    expect(t.fields.some((field) => field.required === true)).toBe(false);

    const draft = t.generate({});
    expect(draft.actionType).toBe('agent');
    expect(draft.agentType).toBe('default');
    expect(draft.scheduleType).toBe('cron');
    expect(draft.cronExpression).toBe('30 8 * * 1-5');
    // 本地时区：不钉死 Asia/Shanghai（存量模板的历史写法），取运行机器的系统时区
    expect(draft.cronTimezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

    const input = buildCronJobInput(draft);
    expect(input.action.type).toBe('agent');
    expect(input.schedule).toEqual({
      type: 'cron',
      expression: '30 8 * * 1-5',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('提示词要求三档分组、每档最多 5 条', () => {
    const prompt = template('morning-triage').generate({}).agentPrompt;
    expect(prompt).toContain('今天必须处理');
    expect(prompt).toContain('可等');
    expect(prompt).toContain('只需知道');
    expect(prompt).toMatch(/每档最多 5 条/);
  });

  it('提示词要求没有内容时明说「今早没有需要处理的」，不硬凑、不空产物', () => {
    const prompt = template('morning-triage').generate({}).agentPrompt;
    expect(prompt).toContain('今早没有需要处理的');
    expect(prompt).toMatch(/不要硬凑/);
    expect(prompt).toMatch(/空/);
  });

  it('失败腿：没有可用邮箱/IM/日历连接时产出说明缺什么连接，不报错', () => {
    const prompt = template('morning-triage').generate({}).agentPrompt;
    expect(prompt).toMatch(/不要报错/);
    expect(prompt).toMatch(/缺少哪些连接/);
  });

  it('展示文案走 i18n：中英词条都登记，未登记模板回退对象内兜底文案', () => {
    const t = template('morning-triage');
    expect(getTemplateDisplayCopy(t, cronCenterZh.cronCenter.templates)).toEqual({
      name: '晨间分诊',
      description: '汇总昨晚到现在的未读邮件、消息和日历变动',
      scheduleLabel: '工作日 08:30',
    });
    expect(getTemplateDisplayCopy(t, cronCenterEn.cronCenter.templates)).toEqual({
      name: 'Morning triage',
      description: 'Round up unread mail, messages, and calendar changes since last night',
      scheduleLabel: 'Weekdays 08:30',
    });

    // 兜底：i18n 没登记的模板（存量模板）用对象内文案
    expect(getTemplateDisplayCopy(t, {})).toEqual({
      name: t.name,
      description: t.description,
      scheduleLabel: t.scheduleLabel,
    });
    expect(getTemplateDisplayCopy(t, undefined)).toEqual({
      name: t.name,
      description: t.description,
      scheduleLabel: t.scheduleLabel,
    });
  });
});
