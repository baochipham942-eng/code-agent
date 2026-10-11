import { describe, it, expect } from 'vitest';
import { normalizeAction } from '../../../src/host/cron/cronNormalizers';
import { CRON_URGENCY_CRITERIA } from '../../../src/shared/constants';

// A6-1: AgentAction 新增 roleId / libraryProjectId 必须穿过归一化边界（落库/读取往返），
// 否则字段被静默丢弃 → 自动化「以角色身份跑」「归档到项目库」全旁路（deny-list 静默漏字段同族）。
describe('normalizeAction — agent action A6 fields round-trip', () => {
  it('preserves roleId and libraryProjectId when present', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: '写一份周报',
      roleId: 'muzhi',
      libraryProjectId: 'proj_123',
    });
    expect(action).toMatchObject({
      type: 'agent',
      roleId: 'muzhi',
      libraryProjectId: 'proj_123',
    });
  });

  it('leaves both undefined when absent (零扰动现状)', () => {
    const action = normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x' });
    expect(action).toMatchObject({ type: 'agent', roleId: undefined, libraryProjectId: undefined });
  });

  it('drops non-string values instead of trusting caller shape', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: 'x',
      roleId: 42,
      libraryProjectId: { nested: true },
    });
    expect(action).toMatchObject({ roleId: undefined, libraryProjectId: undefined });
  });
});

// N-CRON-MORNING-TRIAGE-URGENCY-RULE: urgencyCriteria 同样必须穿过归一化边界，
// 否则用户写的紧急判据存得进、读不出，prompt 静默退回内置定义。
describe('normalizeAction — urgencyCriteria round-trip', () => {
  it('preserves a trimmed criterion when present', () => {
    const action = normalizeAction({
      type: 'agent',
      agentType: 'default',
      prompt: '晨间分诊',
      urgencyCriteria: '  只有老板发来的邮件算今天必须处理  ',
    });
    expect(action).toMatchObject({ urgencyCriteria: '只有老板发来的邮件算今天必须处理' });
  });

  it('drops non-string and blank values (undefined)', () => {
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', urgencyCriteria: '   ' }))
      .toMatchObject({ urgencyCriteria: undefined });
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', urgencyCriteria: 42 }))
      .toMatchObject({ urgencyCriteria: undefined });
    expect(normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x' }))
      .toMatchObject({ urgencyCriteria: undefined });
  });

  it('truncates over-length input to CRON_URGENCY_CRITERIA.MAX_CHARS instead of rejecting the action', () => {
    const over = 'a'.repeat(CRON_URGENCY_CRITERIA.MAX_CHARS + 10);
    const action = normalizeAction({ type: 'agent', agentType: 'default', prompt: 'x', urgencyCriteria: over });
    expect(action?.type).toBe('agent');
    if (action?.type !== 'agent') throw new Error('expected an agent action');
    expect(action.urgencyCriteria).toHaveLength(CRON_URGENCY_CRITERIA.MAX_CHARS);
    expect(action.urgencyCriteria).toBe('a'.repeat(CRON_URGENCY_CRITERIA.MAX_CHARS));
  });
});
