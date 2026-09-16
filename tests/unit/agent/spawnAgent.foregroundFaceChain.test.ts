// ============================================================================
// N-SUBAGENT-WEBSEARCH-INHERIT：前台指挥 brain 的本轮工具面不是 spawn 链硬边界
// ============================================================================
// 爸 2026-09-16 真机（run-b3d2c1b5）：brain 把活派给研究子助手「溯真」（角色声明了 WebSearch/WebFetch），
// 子助手 childContext 被 brain 的窄工具面交集成 Grep/Glob/ListDirectory/Write/Read 五件，
// 在本地磁盘搜了 1.5 分钟、凭旧知识答出「两款都还没发布」。
//
// 走真实链路：真 ToolExecutor → 真 ProtocolToolResolver → 真 buildProtocolContext（shadowAdapter
// 逐字段重建上下文，漏搬一个字段就断链）→ 真 spawn_agent handler 派生 SubagentExecutionContext。
// 模型环（executeSpawnAgent）是唯一假点，只用来捕获派生出的上下文。
// ============================================================================

import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeSpawnAgentMock } = vi.hoisted(() => ({ executeSpawnAgentMock: vi.fn() }));

vi.mock('../../../src/host/agent/multiagentTools/spawnAgent', () => ({
  executeSpawnAgent: executeSpawnAgentMock,
  launchAgentTeam: vi.fn(),
}));

import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const FACE = ['Read', 'Grep', 'Glob', 'ListDirectory', 'Write', 'spawn_agent'];

async function spawnWith(options: { allowedToolNames: string[]; foregroundToolFace?: boolean }): Promise<SubagentExecutionContext> {
  const executor = new ToolExecutor({ requestPermission: async () => true, workingDirectory: process.cwd() });
  executor.setAuditEnabled(false);
  executeSpawnAgentMock.mockResolvedValue({ success: true, output: 'chain-ok' });
  const spawned = await executor.execute('spawn_agent', { role: '溯真', task: '对比两款手机' }, {
    sessionId: 'face-chain-session', modelConfig: { provider: 'kimi', model: 'kimi-k2.5' },
    deniedToolNames: ['cancel_task'], ...options,
  });
  expect(spawned.success).toBe(true);
  const derived = executeSpawnAgentMock.mock.calls.at(-1)?.[1] as SubagentExecutionContext | undefined;
  if (!derived) throw new Error('spawn_agent did not derive a subagent execution context');
  return derived;
}

describe('spawn 链：前台 brain 工具面 vs run 级硬边界', () => {
  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(() => { executeSpawnAgentMock.mockReset(); resetPermissionModeManager(); });

  it('前台 brain 的工具面不传给子代理；拒绝集照传', async () => {
    const derived = await spawnWith({ allowedToolNames: FACE, foregroundToolFace: true });
    expect(derived.allowedToolNames).toBeUndefined();
    expect(derived.deniedToolNames).toEqual(['cancel_task']);
  });

  it('对照：CLI --tools 这类 run 级白名单仍是子代理硬边界', async () => {
    const derived = await spawnWith({ allowedToolNames: FACE });
    expect(derived.allowedToolNames).toEqual(FACE);
  });

  // AgentLoop → RuntimeContext → ToolExecutionEngine 两跳是一行透传，单测装不起整条 loop；
  // 钉源码（static-contract），运行时证据看宿主日志「[溯真] Starting with N tools」。
  it('AgentLoop 与 ToolExecutionEngine 把 foregroundToolFace 往下透传', () => {
    expect(readFileSync('src/host/agent/agentLoop.ts', 'utf8')).toContain('foregroundToolFace: config.foregroundToolFace,');
    expect(readFileSync('src/host/agent/runtime/toolExecutionEngine.ts', 'utf8')).toContain('foregroundToolFace: this.ctx.foregroundToolFace,');
  });
});
