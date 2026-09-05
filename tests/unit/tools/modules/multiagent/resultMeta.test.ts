import { describe, expect, it, vi } from 'vitest';
import { AgentFailureCode } from '../../../../../src/shared/contract/agentFailure';
import type { ToolContext } from '../../../../../src/host/protocol/tools';
import { withMultiagentMeta } from '../../../../../src/host/tools/modules/multiagent/resultMeta';

const ctx = { sessionId: 'fixture', logger: { debug: vi.fn() } } as unknown as ToolContext;

describe('subagent failure guidance', () => {
  it.each(Object.values(AgentFailureCode))('adds a next step for %s', failureCode => {
    const result = withMultiagentMeta({ ok: false, error: 'failed', meta: { failureCode } }, ctx, 'AgentSpawn', { agentId: 'fixture-agent' });
    expect(result).toMatchObject({ error: expect.stringContaining('Next step:') });
    if (!result.ok) {
      expect(result.error).toContain('agent_message');
      expect(result.error).toContain('fixture-agent');
      expect(result.error).toContain('send_input');
      expect(result.error).toContain('terminal agents cannot be resumed');
    }
  });

  it('includes actionable budget guidance in parent-visible successful envelopes', () => {
    const result = withMultiagentMeta({ ok: true, output: 'Child failed' }, ctx, 'Task', { result: { failureCode: AgentFailureCode.BudgetExhausted } });
    expect(result).toMatchObject({ output: expect.stringContaining('maxBudget') });
  });

  it('keeps successful child output unchanged', () => {
    expect(withMultiagentMeta({ ok: true, output: 'done' }, ctx, 'Task', {})).toMatchObject({ output: 'done' });
  });
});
