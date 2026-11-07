// ============================================================================
// N-SOL-GAME-AB-FU1 · 行为钉：真 ToolExecutor 里指挥台四工具被硬拒，永不触指挥台
// ============================================================================
// 与 agentAdapter.standaloneUnavailableToolsWiring.test.ts 的接线钉互补：
// 接线钉证明 denylist 进了 AgentLoop 构造配置（类是 mock），经 runtime ctx
// 同时驱动 schema 工具面收窄与执行层硬闸；本钉用**真 ToolExecutor + 真工具注册表**
// （protocolRegistry，无 mock）走执行层：
// denylist 命中的 delegate_task 调用被 denied-tool 错误拒绝，handler 永不解析、
// 永不触 getSessionCommandCenter()，错误里没有「TaskManager not initialized」。
// denylist 名单与 adapter 内 STANDALONE_UNAVAILABLE_TOOLS 同一份（不为测试导出常量，
// knip 门约束——这里按字面复写并在接线钉里钉住一致性）。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 绊线：指挥台服务一旦被触到即失败（正常路径下 deny 闸在 handler 解析之前就返回）。
const commandCenter = vi.hoisted(() => ({ getSessionCommandCenter: vi.fn() }));
vi.mock('../../../src/host/services/commandCenter/sessionCommandCenter', () => ({
  getSessionCommandCenter: commandCenter.getSessionCommandCenter,
}));

import '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getToolResolver } from '../../../src/host/tools/dispatch/toolResolver';
import { filterToolsByRunPolicy } from '../../../src/host/agent/runtime/toolRunPolicy';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const STANDALONE_UNAVAILABLE_TOOLS = [
  'delegate_task',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

const TOOL_CALL_PARAMS: Record<(typeof STANDALONE_UNAVAILABLE_TOOLS)[number], Record<string, unknown>> = {
  delegate_task: {
    title: '调研',
    short_name: '调研',
    lane_key: 'research',
    submission_key: 'sub-1',
    prompt: '做一件事',
  },
  steer_task: { instruction: '加个约束' },
  cancel_task: {},
  task_status: {},
};

describe('standalone denylist 走真 ToolExecutor（N-SOL-GAME-AB-FU1）', () => {
  let sandbox: string;
  const cleanupRoots: string[] = [];

  beforeEach(async () => {
    commandCenter.getSessionCommandCenter.mockClear();
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'suw-exec-')));
    cleanupRoots.push(root);
    sandbox = path.join(root, 'sandbox');
    await fs.mkdir(sandbox);
  });

  afterEach(async () => {
    for (const root of cleanupRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function makeExecutor(): ToolExecutor {
    return new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: sandbox,
    });
  }

  it('denylist 命中的指挥台工具直调被拒为 denied-tool 错误，且不触 getSessionCommandCenter', async () => {
    const executor = makeExecutor();
    for (const toolName of STANDALONE_UNAVAILABLE_TOOLS) {
      const result = await executor.execute(toolName, TOOL_CALL_PARAMS[toolName], {
        sessionId: 'eval-session',
        deniedToolNames: [...STANDALONE_UNAVAILABLE_TOOLS],
      });
      expect(result.success, `${toolName} must be refused`).toBe(false);
      expect(result.error).toBe(`Tool not allowed: ${toolName} (disabled by --tools/--disallowed-tools)`);
      expect(result.error).not.toContain('TaskManager not initialized');
    }
    expect(commandCenter.getSessionCommandCenter).not.toHaveBeenCalled();
  });

  it('denylist 装进 runtime ctx 后四工具被收出 schema 工具面（工具面收窄仍是 AgentLoop 那道闸）', () => {
    const resolver = getToolResolver();
    const tools = [...STANDALONE_UNAVAILABLE_TOOLS, 'bash']
      .map((name) => resolver.getDefinition(name))
      .filter((definition) => definition !== undefined);
    expect(tools.map((definition) => definition.name)).toContain('delegate_task');

    const ctx = {
      sessionId: 'eval-session',
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 0 }],
      deniedToolNames: [...STANDALONE_UNAVAILABLE_TOOLS],
    } as unknown as RuntimeContext;

    const face = filterToolsByRunPolicy(tools, ctx).map((definition) => definition.name);
    expect(face).toEqual(['Bash']);
  });
});
