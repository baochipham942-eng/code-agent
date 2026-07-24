import { describe, expect, it } from 'vitest';
import { CRON_TEMPLATES } from '../../../src/renderer/components/features/cron/cronTemplates';
import { CRON_AGENT_SNAPSHOT, EXTERNAL_WATCH } from '../../../src/shared/constants';

function template(id: string) {
  const t = CRON_TEMPLATES.find((tpl) => tpl.id === id);
  if (!t) throw new Error(`template ${id} not found`);
  return t;
}

describe('飞书日程冲突监听模板', () => {
  const draft = template('feishu-calendar-conflict').generate({ calendarId: 'cal-xyz', schedule: '' });
  const context = JSON.parse(draft.agentContextText) as Record<string, unknown>;

  it('是开了变化追踪的 agent 任务，且带 external_event 派生所需的 externalWatch 标志', () => {
    expect(draft.actionType).toBe('agent');
    expect(context[CRON_AGENT_SNAPSHOT.ENABLED_KEY]).toBe(true);
    expect(context[EXTERNAL_WATCH.CONTEXT_KEY]).toEqual({
      source: EXTERNAL_WATCH.SOURCE_CALENDAR,
      calendarId: 'cal-xyz',
    });
  });

  it('prompt 守住硬口径：当天 00:00 起点 + 分页下限 50，且不含英文 page、不调 field.list', () => {
    expect(draft.agentPrompt).toContain('00:00');
    expect(draft.agentPrompt).toMatch(/分页条数不少于 50/);
    // P2：英文 "page"（如 page_size）会被 skill-alias 匹配器拿子串误撞 design-brief，
    // 用中文「分页」措辞绕开，模型从工具 schema 认 page_size 参数即可。
    expect(draft.agentPrompt).not.toMatch(/page/i);
    expect(draft.agentPrompt).not.toMatch(/field\.list|appTableField/);
  });

  it('prompt 要求无新增冲突时不输出 <cron_alert>（无变化则安静）', () => {
    expect(draft.agentPrompt).toMatch(/没有新增冲突[，,].*不要输出 <cron_alert>/);
  });
});

describe('飞书表格行变更监听模板', () => {
  const draft = template('feishu-table-change').generate({
    baseAppToken: 'app-tok',
    tableId: 'tblABC',
    schedule: '',
  });
  const context = JSON.parse(draft.agentContextText) as Record<string, unknown>;

  it('是开了变化追踪的 agent 任务，externalWatch 带 base+table', () => {
    expect(draft.actionType).toBe('agent');
    expect(context[CRON_AGENT_SNAPSHOT.ENABLED_KEY]).toBe(true);
    expect(context[EXTERNAL_WATCH.CONTEXT_KEY]).toEqual({
      source: EXTERNAL_WATCH.SOURCE_TABLE,
      baseAppToken: 'app-tok',
      tableId: 'tblABC',
    });
  });

  it('走 record.search 取字段做指纹，不调 field.list（模型姿势坑，字段从记录直接取）', () => {
    expect(draft.agentPrompt).toMatch(/appTableRecord\.search/);
    expect(draft.agentPrompt).not.toMatch(/field\.list|appTableField/);
  });

  it('prompt 要求无变更时不输出 <cron_alert>', () => {
    expect(draft.agentPrompt).toMatch(/没有.*不要输出 <cron_alert>/);
  });
});
