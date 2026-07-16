import { describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { getBackgroundSubagentRegistry } from '../../../../../src/host/agent/backgroundSubagentRegistry';
import { executeCollectAgent } from '../../../../../src/host/tools/modules/multiagent/collectAgent';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'sess-collect',
    workingDir: '/tmp/test',
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('collect_agent', () => {
  it('passes declaredOutputs from background agent status into result meta and artifact metadata', async () => {
    const agentId = getBackgroundSubagentRegistry().spawn(async () => ({
      success: true,
      output: 'done',
      toolsUsed: [],
      iterations: 1,
    }), {
      role: 'report-writer',
      declaredOutputs: ['markdown 报告'],
    });

    const result = await executeCollectAgent({ agentId }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        tool: 'collect_agent',
        action: 'collect',
        status: 'completed',
        agentId,
        declaredOutputs: ['markdown 报告'],
        artifact: expect.objectContaining({
          metadata: expect.objectContaining({
            tool: 'collect_agent',
            action: 'collect',
            status: 'completed',
            declaredOutputs: ['markdown 报告'],
          }),
        }),
      });
    }
  });
});
