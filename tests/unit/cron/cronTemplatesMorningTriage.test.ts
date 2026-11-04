import { describe, expect, it } from 'vitest';
import {
  CRON_TEMPLATES,
  FEATURED_CRON_TEMPLATES,
  getTemplateDisplayCopy,
  type CronTemplate,
} from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

/** 未绑定角色时的提示词，与改动前 morning-triage.generate 的原文逐字节相同。 */
const PREVIOUS_UNBOUND_PROMPT =
  '请汇总我从昨晚到现在的未读邮件、即时消息和日历变动，给我一份晨间分诊。' +
  '先盘点我当前可用的连接（邮箱、IM、日历），有什么用什么。' +
  '把值得关注的条目按「今天必须处理 / 可等 / 只需知道」三档列出，每档最多 5 条，挑最重要的；每条一句话说明是什么、为什么归到这一档。' +
  '如果今早没有任何需要处理或值得知道的内容，直接明说「今早没有需要处理的」，不要硬凑条目，也不要产出空列表。' +
  '已连接但本次读取失败的来源（邮件/IM/日历），要在产出里逐一点名为「未读取：<来源>」，读取失败绝不能被当成「今早没有需要处理的」上报。' +
  '如果没有任何可用的邮箱/IM/日历连接，不要报错：在产出里说明缺少哪些连接、各自能补上什么信息，并建议我去设置里连接。';

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
    expect(t.fields).toEqual([
      { key: 'roleId', label: '交给哪位角色（可选）', type: 'role' },
    ]);
    expect(t.fields.some((field) => field.required === true)).toBe(false);
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

  it('已连接但读取失败的来源逐一点名「未读取」，不得当成「今早没有需要处理的」（N-CRON-MORNING-TRIAGE-URGENCY-RULE）', () => {
    const prompt = template('morning-triage').generate({}).agentPrompt;
    expect(prompt).toContain('「未读取：<来源>」');
    expect(prompt).toMatch(/逐一点名/);
    expect(prompt).toMatch(/读取失败绝不能被当成「今早没有需要处理的」上报/);
    // 既有的「没有内容」与「没有连接」两句保持不动
    expect(prompt).toContain('今早没有需要处理的');
    expect(prompt).toContain('缺少哪些连接');
  });

  it('没选角色时草稿与改动前逐字节相同；选了角色才绑定并追加起草规则', () => {
    const unbound = template('morning-triage').generate({});
    const empty = template('morning-triage').generate({ roleId: '' });
    const blank = template('morning-triage').generate({ roleId: '  \n  ' });
    expect(JSON.stringify(unbound)).toBe(JSON.stringify(empty));
    expect(JSON.stringify(unbound)).toBe(JSON.stringify(blank));
    expect(unbound.agentPrompt).toBe(PREVIOUS_UNBOUND_PROMPT);
    expect(unbound.agentRoleId).toBe('');
    expect(unbound.agentPrompt).not.toContain('草稿（未发送）');
    expect(unbound.agentPrompt).not.toContain('草稿 N（未发送）');
    expect(unbound.agentPrompt).toContain('「未读取：<来源>」');
    expect(unbound.agentPrompt).toContain('今早没有需要处理的');

    const bound = template('morning-triage').generate({ roleId: ' assistant-lin ' });
    expect(bound.agentRoleId).toBe('assistant-lin');
    expect(bound.agentPrompt.startsWith(`${PREVIOUS_UNBOUND_PROMPT}\n`)).toBe(true);
    expect(bound.agentPrompt).toContain('「草稿 N（未发送）」');
    expect(bound.agentPrompt).not.toContain('「草稿（未发送）」');
    expect(bound.agentPrompt).toContain('第二行只写收件人的邮箱地址');
    expect(bound.agentPrompt).toContain('不要写显示名');
    expect(bound.agentPrompt).toContain('不要加尖括号');
    expect(bound.agentPrompt).toContain('（来源：发件人 · 主题）');
    expect(bound.agentPrompt).toContain('（来源：日程标题 · 时间）');
    expect(bound.agentPrompt).toContain('日程冲突');
    expect(bound.agentPrompt).toContain('mail_send');
    expect(bound.agentPrompt).toContain('mail_draft');
    expect(bound.agentPrompt).toContain('calendar_create_event');
    expect(bound.agentPrompt).toContain('「存草稿 N」');
    expect(bound.agentPrompt).toContain('「未读取：<来源>」');
    expect(bound.agentPrompt).toContain('今早没有需要处理的');
    const { agentPrompt: boundPrompt, agentRoleId, ...boundRest } = bound;
    const { agentPrompt: unboundPrompt, agentRoleId: unboundRole, ...unboundRest } = unbound;
    expect(boundPrompt).not.toBe(unboundPrompt);
    expect(agentRoleId).not.toBe(unboundRole);
    expect(boundRest).toEqual(unboundRest);

    const input = buildCronJobInput(bound);
    expect(input.action).toMatchObject({ type: 'agent', roleId: 'assistant-lin' });
  });

  it('角色字段的中英文案登记在 cronCenter', () => {
    expect(cronCenterZh.cronCenter.templateRoleLabel).toBe('交给哪位角色（可选）');
    expect(cronCenterZh.cronCenter.templateRoleNone).toBe('不指定');
    expect(cronCenterEn.cronCenter.templateRoleLabel).toBe('Hand this to a role (optional)');
    expect(cronCenterEn.cronCenter.templateRoleNone).toBe('None');
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
