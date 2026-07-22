import { describe, it, expect } from 'vitest';
import { normalizeAction } from '../../../src/host/cron/cronNormalizers';

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
