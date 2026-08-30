// ============================================================================
// P4 审批真链路集成测试（无模型、无 Ink）：
// 真 ToolExecutor + 真 commandSafety 分类（'git reset --hard' 确定性 ask，
// 不触发 LLM 分类）+ 真 createCLIPermissionHandler + provider 注册点。
// toolResolver 按仓库既有模式 mock（真实 bash 模块会调 LLM 生成描述，测试环境无 key）。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import {
  createCLIPermissionHandler,
  setInteractiveApprovalProvider,
} from '../../../../src/cli/permissionPolicy';
import type { PermissionRequestData } from '../../../../src/host/tools/types';

const BASH_DEF = {
  name: 'bash',
  description: 'shell test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: true,
  permissionLevel: 'execute' as const,
};

describe('P4 审批真链路（executor → classifier → permissionPolicy → provider）', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.getDefinition.mockReturnValue(BASH_DEF);
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    setInteractiveApprovalProvider(null);
  });

  it('provider approve → 命令执行；provider deny → 命令被拒绝（denialSource=user）', async () => {
    const seen: PermissionRequestData[] = [];
    setInteractiveApprovalProvider(async (request) => {
      seen.push(request);
      return { approved: true };
    });
    // forcePermissionHandler：绕过 exec-policy 白名单 / classifier 自动放行捷径，
    // 一切 permissioned 工具走 requestPermission（等价生产 forRun 的 force 语义；
    // 本机用户级 exec-policy.json 里有 allow git reset，不 force 会短路掉 ask）
    const executor = new ToolExecutor({
      requestPermission: createCLIPermissionHandler({}),
      workingDirectory: '/tmp/p4-approval-chain',
      forcePermissionHandler: true,
    });

    const approved = await executor.execute('bash', { command: 'git reset --hard' }, { sessionId: 's1' });
    expect(approved.success).toBe(true);
    // 确定性 ask 路由到了 provider（不是 no-approval-ui 拒掉，也不是 auto-approve 短路）
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe('bash');
    expect(String(seen[0].details.command)).toContain('git reset --hard');

    seen.length = 0;
    setInteractiveApprovalProvider(async (request) => {
      seen.push(request);
      return { approved: false, denialSource: 'user' };
    });
    const denied = await executor.execute('bash', { command: 'git reset --hard' }, { sessionId: 's1' });
    expect(denied.success).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('无 provider（headless）→ no-approval-ui fail-closed', async () => {
    setInteractiveApprovalProvider(null);
    // forcePermissionHandler：绕过 exec-policy 白名单 / classifier 自动放行捷径，
    // 一切 permissioned 工具走 requestPermission（等价生产 forRun 的 force 语义；
    // 本机用户级 exec-policy.json 里有 allow git reset，不 force 会短路掉 ask）
    const executor = new ToolExecutor({
      requestPermission: createCLIPermissionHandler({}),
      workingDirectory: '/tmp/p4-approval-chain',
      forcePermissionHandler: true,
    });
    const result = await executor.execute('bash', { command: 'git reset --hard' }, { sessionId: 's1' });
    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });
});
