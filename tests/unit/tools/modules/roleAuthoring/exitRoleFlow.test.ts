// ============================================================================
// exit_role_flow 测试 — 退出建/改角色严格流程（草稿不动）
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { exitRoleFlowModule } from '../../../../../src/host/tools/modules/roleAuthoring/exitRoleFlow';
import { EXIT_ROLE_FLOW_TOOL_NAME } from '../../../../../src/host/tools/modules/roleAuthoring/exitRoleFlow.schema';
import type { ToolContext, CanUseToolFn } from '../../../../../src/host/protocol/tools';

function mkToolCtx(aborted = false): ToolContext {
  return {
    abortSignal: { aborted } as AbortSignal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sessionId: 's1',
    emit: vi.fn(),
  } as unknown as ToolContext;
}

const allow: CanUseToolFn = async () => ({ allow: true });

describe('exit_role_flow', () => {
  it('成功返回 exitedRoleFlow 标记，输出告知草稿保留、继续用户请求', async () => {
    const handler = exitRoleFlowModule.createHandler();
    const result = await handler.execute({ reason: '用户要整理股票复盘报告' }, mkToolCtx(), allow);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.exitedRoleFlow).toBe(true);
      expect(result.output).toContain('草稿');
      expect(result.output).toContain('继续');
    }
  });

  it('abort 后不执行', async () => {
    const handler = exitRoleFlowModule.createHandler();
    const result = await handler.execute({}, mkToolCtx(true), allow);
    expect(result.ok).toBe(false);
  });

  it('工具名常量与 schema 一致（sticky 扫描与引擎特判共用同一真源）', () => {
    expect(exitRoleFlowModule.schema.name).toBe(EXIT_ROLE_FLOW_TOOL_NAME);
    // 只读、无副作用：不应触发权限审批链路
    expect(exitRoleFlowModule.schema.readOnly).toBe(true);
  });
});
