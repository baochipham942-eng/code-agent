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

  it('前台超时转后台（adopt）：collect 结果与完成通知都带 missingTools，父模型看得见能力缺口（N-SUBAGENT-ZEROTOOLS 返修）', async () => {
    const registry = getBackgroundSubagentRegistry();
    // adopt 的入参是 executor 的原始 SubagentResult（missingTools 已在）
    const agentId = registry.adopt(
      Promise.resolve({
        success: true,
        output: 'partial completion',
        toolsUsed: [],
        iterations: 3,
        missingTools: ['mcp__cua-driver__*'],
      }),
      {
        agentId: 'fg-to-bg-missing-tools-1',
        role: 'coder',
        title: '前台转后台',
        sessionId: 'sess-collect-fg-bg',
      },
    );
    await registry.await(agentId);

    const result = await executeCollectAgent({ agentId }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Missing tools');
      expect(result.output).toContain('mcp__cua-driver__*');
      expect(result.meta).toMatchObject({
        result: expect.objectContaining({ missingTools: ['mcp__cua-driver__*'] }),
      });
    }
    // 父模型每轮注入的完成通知同样要带缺失清单（统一完成通知链）
    const notifications = registry.drainCompletionNotifications({ sessionId: 'sess-collect-fg-bg' });
    const notification = notifications.find((entry) => entry.agentId === agentId);
    expect(notification?.content).toContain('mcp__cua-driver__*');
  });
});
