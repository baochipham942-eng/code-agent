// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE3 · 接线钉（缺省开翻转后）
// ============================================================================
// 钉三件事：
// ①「缺省开着」——restrictWritesToWorkspace 不传时 adapter 构造的 ToolExecutor 带
//   scope/runContext/开关，AgentLoop 收同源 runId（ENABLE3 起缺省即开，与显式 true 同形）。
// ②「显式 true 接线正确」——scope 双根（沙箱 primary + 记忆 additional）、
//   runId 同源（executor 与 AgentLoop 必须同一个，否则每次工具调用撞 RUN_CONTEXT_MISMATCH）、
//   workingDirectory 用 runContext.cwd（canonicalize 后的，防 cwd 字面量 mismatch 抛）。
// ③「显式 false 回退与改前一字不差」——不注入 scope/runContext、loop 不收 runId
//   （对照/回退路径仍受 #1686 第五轮惰性铁律约束；行为证明在
//   agentAdapter.writeBoundaryBehavior.test.ts）。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  executorConfigs: [] as Array<Record<string, unknown>>,
  loopConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class ToolExecutor {
    constructor(config: Record<string, unknown>) {
      captured.executorConfigs.push(config);
    }
  },
}));

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class AgentLoop {
    constructor(config: Record<string, unknown>) {
      captured.loopConfigs.push(config);
    }
    async run(): Promise<void> { /* no-op */ }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  SYSTEM_PROMPT: 'test system prompt',
}));

vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    startSession: vi.fn(),
    endSession: vi.fn(),
    handleEvent: vi.fn(),
    createAdapter: vi.fn(() => ({})),
    systemPromptCache: undefined,
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';

describe('评测 adapter 写边界接线（restrictWritesToWorkspace）', () => {
  let dataDir: string;
  let sandbox: string;
  const cleanupRoots: string[] = [];
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    captured.executorConfigs.length = 0;
    captured.loopConfigs.length = 0;
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-wire-')));
    cleanupRoots.push(root);
    dataDir = path.join(root, 'data');
    sandbox = path.join(root, 'a-sandbox');
    await fs.mkdir(dataDir);
    await fs.mkdir(sandbox);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    for (const root of cleanupRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function makeAdapter(restrictWritesToWorkspace?: boolean): StandaloneAgentAdapter {
    return new StandaloneAgentAdapter({
      workingDirectory: sandbox,
      modelConfig: { provider: 'mock', model: 'mock-model' },
      ...(restrictWritesToWorkspace !== undefined ? { restrictWritesToWorkspace } : {}),
    });
  }

  it('缺省（不传开关）：接线开着——与显式 true 同形（ENABLE3 缺省开）', async () => {
    await makeAdapter().sendMessage('hello');
    expect(captured.executorConfigs).toHaveLength(1);
    const executorConfig = captured.executorConfigs[0];
    const loopConfig = captured.loopConfigs[0];
    expect(loopConfig).toBeDefined();

    // 缺省开 = 与显式 true 同形：注入 scope/runContext，loop 收同源 runId。
    expect(executorConfig.restrictWritesToWorkspace).toBe(true);
    const runContext = executorConfig.runContext as {
      runId: string; cwd: string;
      workspaceScope?: { roots: Array<{ role: string }> };
    };
    expect(runContext).toBeDefined();
    expect(executorConfig.workingDirectory).toBe(runContext.cwd);
    expect(loopConfig.runId).toBe(runContext.runId);
    expect((runContext.workspaceScope?.roots ?? []).length).toBeGreaterThan(0);
  });

  it('开关显式 true：接线打开——scope 双根 + runId 同源 + cwd 对齐', async () => {
    await makeAdapter(true).sendMessage('hello');
    expect(captured.executorConfigs).toHaveLength(1);
    const executorConfig = captured.executorConfigs[0];
    const loopConfig = captured.loopConfigs[0];
    expect(loopConfig).toBeDefined();

    expect(executorConfig.restrictWritesToWorkspace).toBe(true);
    const runContext = executorConfig.runContext as {
      runId: string; sessionId: string; cwd: string;
      workspaceScope?: { roots: Array<{ sourceId: string; role: string; path: string }> };
    };
    expect(runContext).toBeDefined();
    // workingDirectory 必须用 runContext.cwd（canonicalize 后），否则构造期抛 cwd mismatch
    expect(executorConfig.workingDirectory).toBe(runContext.cwd);
    // runId 同源：AgentLoop 与 executor 必须同一个 runId（#1686 第一轮坑）
    expect(loopConfig.runId).toBe(runContext.runId);
    // scope 双根：沙箱 primary + 记忆 additional（数据目录在沙箱外 ⇒ 两个根）
    const roots = runContext.workspaceScope?.roots ?? [];
    expect(roots.map((root) => root.role).sort()).toEqual(['additional', 'primary']);
    expect(roots.find((root) => root.role === 'primary')?.path).toBe(runContext.cwd);
    expect(roots.find((root) => root.sourceId === 'eval-memory')?.path)
      .toBe(path.join(dataDir, 'memory'));
  });

  it('开关显式 false（回退杆）：与改前一字不差——无 scope 注入、无 runContext、loop 不收 runId', async () => {
    await makeAdapter(false).sendMessage('hello');
    expect(captured.executorConfigs).toHaveLength(1);
    const executorConfig = captured.executorConfigs[0];
    const loopConfig = captured.loopConfigs[0];
    expect(loopConfig).toBeDefined();

    // 🔴 惰性铁律：关着时不能有任何 scope 被注入（#1686 第五轮：注入 runContext 会
    // 顺带点亮 Bash working_directory 闸）。runContext 缺席 = 那道闸不会被点亮。
    expect(executorConfig.runContext).toBeUndefined();
    expect(executorConfig.workingDirectory).toBe(sandbox);
    // 字段整个不出现（不是 false）：OFF 分支的 spread 为空，构造参数形状与改前逐键一致。
    expect('restrictWritesToWorkspace' in executorConfig).toBe(false);
    expect(executorConfig.restrictWritesToWorkspace).toBeUndefined();
    // 改前 adapter 从不给 AgentLoop 传 runId（loop 自造）
    expect('runId' in loopConfig).toBe(false);
  });

  it('CODE_AGENT_DATA_DIR 落在沙箱内时不加记忆根（根重叠会撞 createWorkspaceScope 抛）', async () => {
    // #1686 第三轮：CODE_AGENT_DATA_DIR 设成沙箱子目录时记忆目录落在沙箱内，
    // 再加一个根会撞 assertNonOverlappingRoots 直接抛，评测起不来。
    const innerDataDir = path.join(sandbox, '.data');
    await fs.mkdir(innerDataDir);
    process.env.CODE_AGENT_DATA_DIR = innerDataDir;
    try {
      await makeAdapter(true).sendMessage('hello');
      const runContext = captured.executorConfigs[0].runContext as {
        workspaceScope?: { roots: Array<{ sourceId: string }> };
      };
      expect(runContext.workspaceScope?.roots.map((root) => root.sourceId))
        .toEqual(['eval-sandbox']);
    } finally {
      process.env.CODE_AGENT_DATA_DIR = dataDir;
      await fs.rm(innerDataDir, { recursive: true, force: true });
    }
  });
});
