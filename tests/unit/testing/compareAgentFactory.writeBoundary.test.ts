// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE3 · compare 入口 OFF 杆接线（缺省开翻转后）
// ============================================================================
// 钉三件事：
// ① eval-ci 的 compare makeAgent 读 NEO_EVAL_WRITE_BOUNDARY（缺省开，=off 显式关）——与
//   createAgent() 同款口径（源码钉，eval-ci 是脚本，沿 compareWiring.test.ts 的
//   readFileSync 模式）。
// ② 工厂三态接线：缺省（不传）→ 开（adapter `?? true`，注入 scope/runContext）；
//   显式 true → 同款开；显式 false → 与 #1700 合入前的 compare 链路一字不差
//   （无 scope、无 runContext、loop 不收 runId，对照/回退用）。
// ③ 行为：开着时经真实构造链（createCompareAgent → adapter → executor → spawn_agent
//   派生链）的 compare 臂子代理越界写被拒且不落盘、沙箱内写真落盘。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

const { executeSpawnAgentMock } = vi.hoisted(() => ({
  executeSpawnAgentMock: vi.fn(),
}));

vi.mock('../../../src/host/agent/multiagentTools/spawnAgent', () => ({
  executeSpawnAgent: executeSpawnAgentMock,
  launchAgentTeam: vi.fn(),
}));

// 真 ToolExecutor 子类捕获构造参数（行为全真，只多记一笔）——scope 从真 compare
// adapter 派生，🚫 手抄 buildEvalRunScoping 的根（knip 生产档不许测试专用导出）。
const captured = vi.hoisted(() => ({
  // ToolExecutorConfig 直存会撞交叉类型（memory：tsc 把 private 字段推成 never）——存 unknown，读处再窄化。
  executorConfigs: [] as unknown[],
  loopConfigs: [] as unknown[],
}));

vi.mock('../../../src/host/tools/toolExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/tools/toolExecutor')>();
  return {
    ...actual,
    ToolExecutor: class extends actual.ToolExecutor {
      constructor(config: ConstructorParameters<typeof actual.ToolExecutor>[0]) {
        captured.executorConfigs.push(config);
        super(config);
      }
    },
  };
});

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

import { createCompareAgent } from '../../../src/host/testing/comparator/compareAgentFactory';
import type { CompareConfiguration } from '../../../src/host/testing/types';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { createRunContext } from '../../../src/host/runtime/runContext';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const BASELINE: CompareConfiguration = { name: 'baseline', model: 'model-a', provider: 'mock' };
const CANDIDATE: CompareConfiguration = { name: 'candidate', model: 'model-a', provider: 'mock' };

describe('compare 入口写边界 OFF 杆（N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE3 缺省开）', () => {
  let parent: string;
  let sandbox: string;
  let outside: string;
  let dataDir: string;
  const cleanupRoots: string[] = [];
  let previousDataDir: string | undefined;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    captured.executorConfigs.length = 0;
    captured.loopConfigs.length = 0;
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cmp-wsb-')));
    cleanupRoots.push(parent);
    sandbox = path.join(parent, 'a-sandbox');
    outside = path.join(parent, 'z-outside');
    dataDir = path.join(parent, 'data');
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    await fs.mkdir(dataDir);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
    executeSpawnAgentMock.mockReset();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    for (const root of cleanupRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function makeCompareAgent(restrictWritesToWorkspace?: boolean) {
    return createCompareAgent(CANDIDATE, BASELINE, {
      workingDirectory: sandbox,
      apiKey: 'test-key',
      requestPermission: async () => ({ approved: true, approvalSource: 'scripted' }),
      ...(restrictWritesToWorkspace !== undefined ? { restrictWritesToWorkspace } : {}),
    });
  }

  it('eval-ci compare makeAgent 读 NEO_EVAL_WRITE_BOUNDARY（缺省开，与 createAgent 同款口径）', () => {
    const evalCiSrc = readFileSync(path.join(
      repoRoot, 'packages/internal/evaluation-center/scripts/eval-ci.ts'), 'utf8');
    const compareCommand = evalCiSrc.slice(
      evalCiSrc.indexOf('async function runCompareCommand'),
      evalCiSrc.indexOf('// --compare: A/B paired blind test'),
    );
    const makeAgent = compareCommand.slice(
      compareCommand.indexOf('const makeAgent ='),
      compareCommand.indexOf('// LLM 评审可选'),
    );
    // 只认 createCompareAgent 分支（real compare 臂）；mock 臂走 createAgent 自带开关。
    const realArm = makeAgent.slice(makeAgent.indexOf('return createCompareAgent'));
    expect(realArm).toMatch(/restrictWritesToWorkspace:\s*process\.env\.NEO_EVAL_WRITE_BOUNDARY !== 'off'/);
  });

  it('缺省（不传开关）：compare 臂接线打开——scope 双根 + runId 同源（ENABLE3 缺省开）', async () => {
    await makeCompareAgent().sendMessage('compare default-on probe');
    expect(captured.executorConfigs).toHaveLength(1);
    const executorConfig = captured.executorConfigs[0] as Record<string, unknown>;
    const loopConfig = captured.loopConfigs[0] as Record<string, unknown>;
    expect(loopConfig).toBeDefined();
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

  it('显式 false（回退杆）：compare 臂与 #1700 合入前一字不差——无 scope/runContext，loop 不收 runId', async () => {
    await makeCompareAgent(false).sendMessage('compare parity probe');
    expect(captured.executorConfigs).toHaveLength(1);
    const executorConfig = captured.executorConfigs[0] as Record<string, unknown>;
    const loopConfig = captured.loopConfigs[0] as Record<string, unknown>;
    expect(loopConfig).toBeDefined();
    expect(executorConfig.runContext).toBeUndefined();
    expect(executorConfig.workingDirectory).toBe(sandbox);
    expect('restrictWritesToWorkspace' in executorConfig).toBe(false);
    expect('runId' in loopConfig).toBe(false);
  });

  it('显式 true：compare 臂接线打开——scope 双根 + runId 同源 + cwd 对齐', async () => {
    await makeCompareAgent(true).sendMessage('compare wiring probe');
    expect(captured.executorConfigs).toHaveLength(1);
    const executorConfig = captured.executorConfigs[0] as Record<string, unknown>;
    const loopConfig = captured.loopConfigs[0] as Record<string, unknown>;
    expect(executorConfig.restrictWritesToWorkspace).toBe(true);
    const runContext = executorConfig.runContext as {
      runId: string; sessionId: string; cwd: string;
      workspaceScope?: { roots: Array<{ sourceId: string; role: string; path: string }> };
    };
    expect(runContext).toBeDefined();
    expect(executorConfig.workingDirectory).toBe(runContext.cwd);
    expect(loopConfig.runId).toBe(runContext.runId);
    const roots = runContext.workspaceScope?.roots ?? [];
    expect(roots.map((root) => root.role).sort()).toEqual(['additional', 'primary']);
    expect(roots.find((root) => root.role === 'primary')?.path).toBe(runContext.cwd);
  });

  /** 从 compare 臂 adapter 派生的 scope 出发，经真实 spawn_agent 派发链拉起子代理。
   *  缺省（不传开关）构造——行为证明走缺省开路径本身，不靠显式 true。 */
  async function spawnCompareArmSubagent(): Promise<SubagentExecutionContext> {
    await makeCompareAgent().sendMessage('compare spawn probe');
    const adapterRunContext = (captured.executorConfigs.at(-1) as Record<string, unknown> | undefined)?.runContext as
      | import('../../../src/host/runtime/runContext').RunContext | undefined;
    if (!adapterRunContext?.workspaceScope) throw new Error('compare arm adapter did not build a scoped runContext');
    const runContext = createRunContext({
      runId: 'cmp-wsb-run',
      sessionId: 'cmp-wsb-session',
      workspace: sandbox,
      workspaceScope: adapterRunContext.workspaceScope,
      cwd: adapterRunContext.cwd,
    });
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: runContext.cwd,
      ledgerOrigin: 'eval',
      restrictWritesToWorkspace: true,
      runContext,
    });
    executor.setAuditEnabled(false);
    executeSpawnAgentMock.mockResolvedValue({ success: true, output: 'compare-arm-ok' });
    const spawned = await executor.execute(
      'spawn_agent',
      { role: 'coder', task: 'compare arm write boundary probe' },
      { sessionId: 'cmp-wsb-session', modelConfig: { provider: 'kimi', model: 'kimi-k2.5' } },
    );
    expect(spawned.success).toBe(true);
    expect(executeSpawnAgentMock).toHaveBeenCalledTimes(1);
    const derived = executeSpawnAgentMock.mock.calls[0]?.[1] as SubagentExecutionContext | undefined;
    if (!derived) throw new Error('spawn_agent did not derive a subagent execution context');
    return derived;
  }

  it('缺省开：compare 臂子代理越界写被拒且不落盘', async () => {
    const escape = path.join(outside, 'compare-escape.txt');
    const derived = await spawnCompareArmSubagent();
    const runtime = createSubagentToolRuntime({
      context: derived,
      sessionId: 'cmp-wsb-session',
      effectiveMode: 'default',
      identity: { agentId: 'cmp-wsb-sub', runId: 'cmp-wsb-run', parentToolUseId: 'cmp-parent' },
      allowedToolNames: new Set(['Write']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    const result = await runtime.executor
      .execute('Write', { file_path: escape, content: 'wsb' }, { sessionId: 'cmp-wsb-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(escape)).toBe(false);
  });

  it('缺省开：compare 臂子代理沙箱内写放行且真落盘（对照面）', async () => {
    const target = path.join(sandbox, 'compare-inside.txt');
    const derived = await spawnCompareArmSubagent();
    const runtime = createSubagentToolRuntime({
      context: derived,
      sessionId: 'cmp-wsb-session',
      effectiveMode: 'default',
      identity: { agentId: 'cmp-wsb-sub', runId: 'cmp-wsb-run', parentToolUseId: 'cmp-parent' },
      allowedToolNames: new Set(['Write']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    const result = await runtime.executor
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'cmp-wsb-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});
