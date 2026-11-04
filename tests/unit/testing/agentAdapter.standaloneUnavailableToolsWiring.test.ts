// ============================================================================
// N-SOL-GAME-AB-FU1 · 接线钉：standalone 评测运行时必须把指挥台后台槽四工具收出工具面
// ============================================================================
// TaskManager 全仓只有 createAgentRuntime 一个 initialize() 调用点；StandaloneAgentAdapter
// 不初始化它 ⇒ delegate_task / steer_task / cancel_task / task_status 在评测 run 里是死路：
// 模型调用拿到 accepted 后台却撞「TaskManager not initialized. Call initialize() first.」
// （N-SOL-GAME-AB：Sol 臂 15/18 artifact_missing 的根因）。
// 本钉断言：缺省 StandaloneAgentAdapter 把 denylist 交给 AgentLoop 配置——loop 把它
// 收进 runtime ctx，schema 工具面收窄（toolRunPolicy）与执行层兜底硬闸
// （ExecuteOptions.deniedToolNames，toolExecutionEngine 逐调用转发）都从这里取；
// ToolExecutor 构造期没有 denylist 参数（ToolExecutorConfig 无此字段，执行层吃
// ExecuteOptions），执行层闸的行为证明在 agentAdapter.unavailableToolsRealExecutor.test.ts。
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

const STANDALONE_UNAVAILABLE_TOOLS = [
  'delegate_task',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

describe('standalone 评测运行时的指挥台工具 denylist 接线', () => {
  let dataDir: string;
  let sandbox: string;
  const cleanupRoots: string[] = [];
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    captured.executorConfigs.length = 0;
    captured.loopConfigs.length = 0;
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'suw-wire-')));
    cleanupRoots.push(root);
    dataDir = path.join(root, 'data');
    sandbox = path.join(root, 'sandbox');
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

  it('缺省构造：AgentLoop 配置带上指挥台四工具的 deniedToolNames', async () => {
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: sandbox,
      modelConfig: { provider: 'mock', model: 'mock-model' },
    });
    await adapter.sendMessage('hello');

    expect(captured.executorConfigs).toHaveLength(1);
    expect(captured.loopConfigs).toHaveLength(1);

    const loopConfig = captured.loopConfigs[0];
    expect(loopConfig.deniedToolNames, 'AgentLoop config must carry the denylist')
      .toEqual(expect.arrayContaining([...STANDALONE_UNAVAILABLE_TOOLS]));
  });
});
