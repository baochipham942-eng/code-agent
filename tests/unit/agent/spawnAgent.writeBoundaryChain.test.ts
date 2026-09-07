// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE · 修复轮 1：spawn_agent 委派链写边界不断链
// ============================================================================
// ai-review Important：shadowAdapter.buildProtocolContext 逐字段重建 protocol 上下文
// 时转发 workspaceScope 却漏掉 restrictWritesToWorkspace——评测 executor 开着边界后，
// 模型经 spawn_agent 委派子代理向沙箱/记忆目录之外 Write，审批放行时越界落盘不被拦。
//
// 本测试走真实链路：真 ToolExecutor（开着边界）→ 真 ProtocolToolResolver → 真
// buildProtocolContext/shadowAdapter → 真 spawn_agent handler 派生
// SubagentExecutionContext → 真 createSubagentToolRuntime 的子代理 executor。
// 🚫 直注子代理上下文——那样绕过 buildProtocolContext，咬不住这条断链。
// 模型环（executeSpawnAgent 的 agent loop）是本链路之外唯一假点：开关不走模型环，
// 走上下文派生，mock 只用来捕获派生出的上下文并让 spawn 立即返回。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeSpawnAgentMock } = vi.hoisted(() => ({
  executeSpawnAgentMock: vi.fn(),
}));

vi.mock('../../../src/host/agent/multiagentTools/spawnAgent', () => ({
  executeSpawnAgent: executeSpawnAgentMock,
  launchAgentTeam: vi.fn(),
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { createRunContext } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

describe('spawn_agent 委派链写边界转发', () => {
  let parent: string;
  let sandbox: string;
  let outside: string;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-chain-')));
    sandbox = path.join(parent, 'a-sandbox');
    outside = path.join(parent, 'z-outside');
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
    executeSpawnAgentMock.mockReset();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    await fs.rm(parent, { recursive: true, force: true });
  });

  /** 从真 ToolExecutor 出发经真实派发链 spawn 一个子代理，返回真实派生出的子代理上下文 */
  async function spawnViaRealChain(): Promise<SubagentExecutionContext> {
    // 与评测 adapter 同构：开着写边界的 run-scoped executor（审批一律放行，
    // 本测试要证明拦住越界写的是边界，不是审批）。
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: sandbox,
      restrictWritesToWorkspace: true,
      runContext: createRunContext({
        runId: 'wsb-chain-run',
        sessionId: 'wsb-chain-session',
        workspace: sandbox,
        cwd: sandbox,
        workspaceScope: createWorkspaceScope('wsb-chain-project', [{
          sourceId: 'sandbox-root', path: sandbox, access: 'read_write', role: 'primary',
        }]),
      }),
    });
    executor.setAuditEnabled(false);
    executeSpawnAgentMock.mockResolvedValue({ success: true, output: 'chain-ok' });

    const spawned = await executor.execute(
      'spawn_agent',
      { role: 'coder', task: 'write boundary chain probe' },
      { sessionId: 'wsb-chain-session', modelConfig: { provider: 'kimi', model: 'kimi-k2.5' } },
    );
    expect(spawned.success).toBe(true);
    expect(executeSpawnAgentMock).toHaveBeenCalledTimes(1);
    const derived = executeSpawnAgentMock.mock.calls[0]?.[1] as SubagentExecutionContext | undefined;
    if (!derived) throw new Error('spawn_agent did not derive a subagent execution context');
    return derived;
  }

  function buildSubagentExecutor(derived: SubagentExecutionContext) {
    const runtime = createSubagentToolRuntime({
      context: derived,
      sessionId: 'wsb-chain-session',
      effectiveMode: 'default',
      identity: { agentId: 'wsb-chain-sub', runId: 'wsb-chain-run', parentToolUseId: 'wsb-parent' },
      allowedToolNames: new Set(['Write']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    return runtime.executor;
  }

  it('开着边界：真实委派链派生的子代理 executor 越界写被拒且不落盘', async () => {
    const escape = path.join(outside, 'chain-escape.txt');
    const result = await buildSubagentExecutor(await spawnViaRealChain())
      .execute('Write', { file_path: escape, content: 'wsb' }, { sessionId: 'wsb-chain-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(escape)).toBe(false);
  });

  it('开着边界：真实委派链派生的子代理 executor 沙箱内写放行且真落盘', async () => {
    // 对照面：拒绝不是「子代理整个写不了」——scope 同链下传，沙箱内必须真落盘。
    const target = path.join(sandbox, 'chain-inside.txt');
    const result = await buildSubagentExecutor(await spawnViaRealChain())
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-chain-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});
