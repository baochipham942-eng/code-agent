// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE · 修复轮 2：worktree 子代理不丢记忆根
// ============================================================================
// ai-review Important：subagentToolRuntime 的 worktree 分支用
// resolveBackgroundWorkspaceAuthority({ workspace }) 重建**单根** scope，丢掉父级
// context.workspaceScope 的 additional 根（eval-memory）。写边界开关经修复轮 1 接通后，
// worktree 子代理的 MemoryWrite(scope="global")（目标 <CODE_AGENT_DATA_DIR>/memory/，
// 在 worktree 根外）被判 PROJECT_SOURCE_OUTSIDE_WORKSPACE——合法记忆任务假阴性。
// 这是 #1686 第二轮「记忆根」形状往派生链深一层。
//
// 本测试走真 createSubagentToolRuntime（🚫 直注 executor——被测路径正是它内部的
// worktree 分支 scope 重建），父级 scope 与评测 adapter 同源（真 adapter 派生的
// sandbox primary + eval-memory additional 双根），cwd 构造真实 agent worktree 路径
// （WORKTREE_BASE_DIR 下），判据锚真实落盘。父级 scope 从真 StandaloneAgentAdapter
// 派生（构造捕获，与评测同码路）——buildEvalRunScoping 是模块内私有，不许为测试开
// export（knip 生产档，#1697 第七轮）。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import { WORKTREE_BASE_DIR } from '../../../src/host/agent/agentWorktreePath';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { WorkspaceScope } from '../../../src/shared/contract/project';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';
import type { ToolExecutor } from '../../../src/host/tools/toolExecutor';

// 父级 scope 从真 StandaloneAgentAdapter 派生（与评测同码路）：Adapter 构造 ToolExecutor
// 时用 importActual 包裹捕获构造参数，AgentLoop 假掉（模型环不参与 scope 派生）。
// buildEvalRunScoping 是模块内私有（knip 生产档不许测试专用导出，#1697 第七轮）。
const captured = vi.hoisted(() => ({
  executorConfigs: [] as Array<{ runContext?: { workspaceScope?: WorkspaceScope } }>,
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
    constructor(_config: unknown) { /* 只读构造参数，不跑模型环 */ }
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

/** 父级 scope 与评测 adapter 同码路：真 adapter 开边界派生，从构造捕获里取。 */
async function evalScopeFromAdapter(workingDirectory: string): Promise<WorkspaceScope> {
  const adapter = new StandaloneAgentAdapter({
    workingDirectory,
    modelConfig: { provider: 'mock', model: 'mock-model' },
    restrictWritesToWorkspace: true,
  });
  await adapter.sendMessage('wsb probe');
  const scope = captured.executorConfigs.at(-1)?.runContext?.workspaceScope;
  if (!scope) throw new Error('adapter 没派生 scope');
  return scope;
}

describe('worktree 子代理记忆根继承', () => {
  let parent: string;
  let sandbox: string;
  let outside: string;
  let dataDir: string;
  let memoryDir: string;
  let worktreeBase: string;
  let worktree: string;
  let previousDataDir: string | undefined;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-wtmr-')));
    sandbox = path.join(parent, 'a-sandbox');
    outside = path.join(parent, 'z-outside');
    dataDir = path.join(parent, 'data');
    await Promise.all([fs.mkdir(sandbox), fs.mkdir(outside), fs.mkdir(dataDir)]);
    memoryDir = path.join(dataDir, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    // 真实 agent worktree 布局：WORKTREE_BASE_DIR 下的子目录（isAgentWorktreePath
    // 靠文件系统 realpath 判定，必须真实存在）。只建/只删自己的子目录，不碰共享基目录。
    await fs.mkdir(WORKTREE_BASE_DIR, { recursive: true });
    worktreeBase = await fs.realpath(WORKTREE_BASE_DIR);
    worktree = await fs.mkdtemp(path.join(worktreeBase, 'wsb-wt-'));
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  });

  /** 父级 scope 与评测 adapter 完全同源：开着边界的真 adapter 派生的双根 scope。 */
  function evalParentScope(): Promise<WorkspaceScope> {
    return evalScopeFromAdapter(sandbox);
  }

  function buildWorktreeSubagentExecutor(parentScope: WorkspaceScope): ToolExecutor {
    // 与真实 spawn 链同构：父 executor 的 ToolContext.workspaceScope 下传到
    // SubagentExecutionContext，子代理 cwd 是 agent worktree 路径（触发 worktree 分支）。
    const context = {
      runId: 'wsb-wtmr-run',
      sessionId: 'wsb-wtmr-session',
      workspace: sandbox,
      workspaceScope: parentScope,
      restrictWritesToWorkspace: true,
      cwd: worktree,
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => true },
      events: { emit: () => { /* no-op */ } },
      abortSignal: new AbortController().signal,
    } as unknown as SubagentExecutionContext;
    const runtime = createSubagentToolRuntime({
      context,
      sessionId: 'wsb-wtmr-session',
      effectiveMode: 'default',
      identity: { agentId: 'wsb-wtmr-agent', runId: 'wsb-wtmr-run', parentToolUseId: 'wsb-parent' },
      allowedToolNames: new Set(['Write', 'MemoryWrite']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    return runtime.executor;
  }

  it('worktree 子代理：MemoryWrite 落记忆根（worktree 根外）放行且真落盘', async () => {
    const result = await buildWorktreeSubagentExecutor(await evalParentScope())
      .execute('MemoryWrite', {
        action: 'write',
        filename: 'wsb-wtmr.md',
        name: 'wsb',
        description: 'worktree subagent memory write',
        type: 'project',
        content: 'written by worktree memory-root test',
      }, { sessionId: 'wsb-wtmr-session' });
    expect(result.success).toBe(true);
    // 判据锚真实副作用：记忆文件真的写进了 <CODE_AGENT_DATA_DIR>/memory/（worktree 根外）
    expect(existsSync(path.join(memoryDir, 'wsb-wtmr.md'))).toBe(true);
  });

  it('worktree 子代理：worktree 根内写放行且真落盘（重建后的 primary 生效）', async () => {
    const target = path.join(worktree, 'wt-inside.txt');
    const result = await buildWorktreeSubagentExecutor(await evalParentScope())
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wtmr-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('worktree 子代理：worktree 根外且记忆根外仍拒且不落盘', async () => {
    const target = path.join(outside, 'wt-escape.txt');
    const result = await buildWorktreeSubagentExecutor(await evalParentScope())
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wtmr-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('父级附加根与 worktree 根重叠：跳过而不是抛（#1686 第三轮形状），worktree 内写仍放行', async () => {
    // additional 根盖住整个 worktree 基目录 ⇒ 与重建的 worktree primary 重叠。
    // createWorkspaceScope 的 assertNonOverlappingRoots 会直接抛（评测起不来那种），
    // 修复必须跳过重叠根：构造不抛、worktree 内照常放行、根外照拒。
    const overlapParentScope = createWorkspaceScope('wsb-wtmr-overlap', [
      { sourceId: 'eval-sandbox', path: sandbox, access: 'read_write', role: 'primary' },
      { sourceId: 'eval-memory', path: worktreeBase, access: 'read_write', role: 'additional' },
    ]);
    const executor = buildWorktreeSubagentExecutor(overlapParentScope);
    const target = path.join(worktree, 'wt-overlap-inside.txt');
    const result = await executor
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wtmr-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

// ============================================================================
// 修复轮 3：记忆目录被父级 primary 折叠时仍显式保留
// ============================================================================
// CODE_AGENT_DATA_DIR 指进沙箱（合法用法，#1686 第三轮认过）时，父级
// buildEvalRunScoping 只产 primary 单根——记忆目录 <dataDir>/memory/ 被折叠覆盖、
// 不产生 eval-memory 附加根，修复轮 2 的附加根继承没有根可继承 ⇒ worktree 子代理的
// MemoryWrite(scope="global") 仍被判 PROJECT_SOURCE_OUTSIDE_WORKSPACE（worktree 根
// 在沙箱外）。口径（爸拍板）：记忆目录始终显式保留（父级授权过它），🚫 不继承父级
// primary 本体。几何：data 在沙箱**里面**（折叠），worktree 在 WORKTREE_BASE_DIR 下。
// ============================================================================

describe('worktree 子代理 · 记忆目录被父级 primary 折叠（修复轮 3）', () => {
  let root: string;
  let sandbox: string;
  let outside: string;
  let dataDir: string;
  let memoryDir: string;
  let worktree: string;
  let previousDataDir: string | undefined;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-wt3-')));
    sandbox = path.join(root, 'a-sandbox');
    outside = path.join(root, 'z-outside');
    dataDir = path.join(sandbox, 'data');
    await Promise.all([fs.mkdir(sandbox), fs.mkdir(outside)]);
    await fs.mkdir(dataDir, { recursive: true });
    memoryDir = path.join(dataDir, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    await fs.mkdir(WORKTREE_BASE_DIR, { recursive: true });
    worktree = await fs.mkdtemp(path.join(await fs.realpath(WORKTREE_BASE_DIR), 'wsb-wt3-'));
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  /** 折叠几何的父级 scope：真 adapter 派生产物（此时应只有 primary 单根）。 */
  function foldedParentScope(): Promise<WorkspaceScope> {
    return evalScopeFromAdapter(sandbox);
  }

  function buildSubagentExecutor(input: {
    parentScope: WorkspaceScope;
    cwd: string;
    boundaryEnabled: boolean;
  }): ToolExecutor {
    const context = {
      runId: 'wsb-wt3-run',
      sessionId: 'wsb-wt3-session',
      workspace: sandbox,
      workspaceScope: input.parentScope,
      restrictWritesToWorkspace: input.boundaryEnabled,
      cwd: input.cwd,
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => true },
      events: { emit: () => { /* no-op */ } },
      abortSignal: new AbortController().signal,
    } as unknown as SubagentExecutionContext;
    const runtime = createSubagentToolRuntime({
      context,
      sessionId: 'wsb-wt3-session',
      effectiveMode: 'default',
      identity: { agentId: 'wsb-wt3-agent', runId: 'wsb-wt3-run', parentToolUseId: 'wsb-parent' },
      allowedToolNames: new Set(['Write', 'MemoryWrite', 'Bash']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    return runtime.executor;
  }

  it('前提钉：CODE_AGENT_DATA_DIR 在沙箱内时评测派生只产 primary 单根（记忆被折叠）', async () => {
    // 任务书前提的几何钉：折叠不成立（比如 adapter 改成显式双根）时这条红，
    // 说明被测前提已变，折叠用例要跟着重审，而不是静默变成双根走轮 2 路径。
    const foldedScope = await foldedParentScope();
    expect(foldedScope.roots.length).toBe(1);
    expect(foldedScope.roots[0].role).toBe('primary');
  });

  it('折叠 + worktree 子代理：MemoryWrite(scope="global") 放行且真落盘（修复轮 3 核心）', async () => {
    const result = await buildSubagentExecutor({ parentScope: await foldedParentScope(), cwd: worktree, boundaryEnabled: true })
      .execute('MemoryWrite', {
        action: 'write',
        scope: 'global',
        filename: 'wsb-wt3.md',
        name: 'wsb',
        description: 'folded memory root test',
        type: 'project',
        content: 'written by folded memory-root test',
      }, { sessionId: 'wsb-wt3-session' });
    expect(result.success).toBe(true);
    // 判据锚真实副作用：记忆文件真的写进 <CODE_AGENT_DATA_DIR>/memory/（worktree 根外、
    // 且只靠「折叠也保留」这条新逻辑才在子级 scope 里）
    expect(existsSync(path.join(memoryDir, 'wsb-wt3.md'))).toBe(true);
  });

  it('折叠 + worktree 子代理：worktree 根外且记忆根外仍拒且不落盘', async () => {
    const target = path.join(outside, 'wt3-escape.txt');
    const result = await buildSubagentExecutor({ parentScope: await foldedParentScope(), cwd: worktree, boundaryEnabled: true })
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wt3-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('折叠 + worktree 子代理：不继承父级 primary 本体——沙箱内（记忆根外）仍拒', async () => {
    // 口径另一面：保留的只有记忆目录，父级 primary（沙箱）不跟着进子级 scope。
    const target = path.join(sandbox, 'wt3-primary-body.txt');
    const result = await buildSubagentExecutor({ parentScope: await foldedParentScope(), cwd: worktree, boundaryEnabled: true })
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wt3-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('折叠 + 普通目录子代理：MemoryWrite 放行（非 worktree 分支零变化）', async () => {
    // 普通目录子代理走 context.workspaceScope 原样（折叠 primary 覆盖记忆目标），
    // 修复只动 worktree 分支——这条钉住非 worktree 路径不被顺手改坏。cwd 必须在
    // 父级工作区内（createRunContext 会拒 scope 外的 cwd，真实非 worktree 子代理也如此）。
    const normalDir = path.join(sandbox, 'sub-dir');
    await fs.mkdir(normalDir);
    const result = await buildSubagentExecutor({ parentScope: await foldedParentScope(), cwd: normalDir, boundaryEnabled: true })
      .execute('MemoryWrite', {
        action: 'write',
        scope: 'global',
        filename: 'wsb-wt3-normal.md',
        name: 'wsb',
        description: 'normal dir subagent memory write',
        type: 'project',
        content: 'written by normal-dir subagent',
      }, { sessionId: 'wsb-wt3-session' });
    expect(result.success).toBe(true);
    expect(existsSync(path.join(memoryDir, 'wsb-wt3-normal.md'))).toBe(true);
  });

  it('折叠 + 开关关着：不合成记忆根——Bash working_directory 指记忆目录被 RUN_WORKSPACE_BOUNDARY 拒', async () => {
    // 保守性 gate：合成只在写边界开着时发生。关着时子级 scope 若多出记忆根，
    // Bash working_directory 闸会被松掉（bindRunScopedParams 按根判）——这条
    // 钉住「关着 = 一字不差」。拒在工具查找之前，不真跑 shell。
    const result = await buildSubagentExecutor({ parentScope: await foldedParentScope(), cwd: worktree, boundaryEnabled: false })
      .execute('Bash', { command: 'pwd', working_directory: memoryDir }, { sessionId: 'wsb-wt3-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('RUN_WORKSPACE_BOUNDARY');
  });

  it('父级 scope 不覆盖记忆目录：不合成记忆根，MemoryWrite 仍拒（判据=父级授权，不是无脑加）', async () => {
    // 防开松：CODE_AGENT_DATA_DIR 在父级 scope 之外（手工构造单根 parent scope，
    // 同轮 2 重叠用例的构造方式）⇒ 父级没授权过记忆目录 ⇒ 不合成 ⇒ 目标在
    // worktree 根外被拒。
    const externalData = path.join(root, 'external-data');
    await fs.mkdir(externalData);
    process.env.CODE_AGENT_DATA_DIR = externalData;
    const unauthorizedParent = createWorkspaceScope('wsb-wt3-noauth', [
      { sourceId: 'eval-sandbox', path: sandbox, access: 'read_write', role: 'primary' },
    ]);
    const result = await buildSubagentExecutor({ parentScope: unauthorizedParent, cwd: worktree, boundaryEnabled: true })
      .execute('MemoryWrite', {
        action: 'write',
        scope: 'global',
        filename: 'wsb-wt3-unauth.md',
        name: 'wsb',
        description: 'unauthorized memory root must not be synthesized',
        type: 'project',
        content: 'must not land',
      }, { sessionId: 'wsb-wt3-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(path.join(externalData, 'memory', 'wsb-wt3-unauth.md'))).toBe(false);
  });
});

// ============================================================================
// 修复轮 4：附加根继承收进开关门内
// ============================================================================
// 轮 2 的通用附加根继承写在 boundaryEnabled 门外——开关关（生产缺省）时父级 worktree
// 外附加根也流进子代理 scope，非评测会话里 Bash({working_directory: <附加根>}) 从
// RUN_WORKSPACE_BOUNDARY 拒变放行，等于默认松了目录边界（#1686 头号纪律「新行为只在
// 新开关下生效」的反面教材）。修复：整个继承合成收进门内，开关关 = 原样返回 worktree
// 单根 scope（一根不多、一字段不变）。
// ============================================================================

describe('worktree 子代理 · 附加根继承收进开关门内（修复轮 4）', () => {
  let root: string;
  let sandbox: string;
  let extraRoot: string;
  let dataDir: string;
  let worktree: string;
  let previousDataDir: string | undefined;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-wt4-')));
    sandbox = path.join(root, 'a-sandbox');
    // 显式附加根：worktree 外的普通目录（非记忆根——把通用继承与轮 3 记忆合成分开钉）。
    extraRoot = path.join(root, 'z-extra');
    // dataDir 放父级 scope 外：记忆目录不被父级授权 ⇒ 轮 3 合成不触发，纯钉通用继承。
    dataDir = path.join(root, 'data');
    await Promise.all([fs.mkdir(sandbox), fs.mkdir(extraRoot), fs.mkdir(dataDir)]);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    await fs.mkdir(WORKTREE_BASE_DIR, { recursive: true });
    worktree = await fs.mkdtemp(path.join(await fs.realpath(WORKTREE_BASE_DIR), 'wsb-wt4-'));
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  /** 父级带显式附加根的双根 scope（手工 createWorkspaceScope，同轮 2/3 用例构造方式）。 */
  function explicitAdditionalRootScope(): WorkspaceScope {
    return createWorkspaceScope('wsb-wt4-project', [
      { sourceId: 'eval-sandbox', path: sandbox, access: 'read_write', role: 'primary' },
      { sourceId: 'parent-extra', path: extraRoot, access: 'read_write', role: 'additional' },
    ]);
  }

  /** boundary: 'absent'（字段不带，生产缺省态）| false | true。 */
  function buildExecutor(input: { parentScope: WorkspaceScope; boundary: 'absent' | boolean }): ToolExecutor {
    const context = {
      runId: 'wsb-wt4-run',
      sessionId: 'wsb-wt4-session',
      workspace: sandbox,
      workspaceScope: input.parentScope,
      ...(input.boundary === 'absent' ? {} : { restrictWritesToWorkspace: input.boundary }),
      cwd: worktree,
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => true },
      events: { emit: () => { /* no-op */ } },
      abortSignal: new AbortController().signal,
    } as unknown as SubagentExecutionContext;
    const runtime = createSubagentToolRuntime({
      context,
      sessionId: 'wsb-wt4-session',
      effectiveMode: 'default',
      identity: { agentId: 'wsb-wt4-agent', runId: 'wsb-wt4-run', parentToolUseId: 'wsb-parent' },
      allowedToolNames: new Set(['Write', 'Bash']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    return runtime.executor;
  }

  it('开关关（缺省态，字段不带）：Bash working_directory 指父级附加根仍 RUN_WORKSPACE_BOUNDARY 拒', async () => {
    // 「关着时与改前一字不差」在这条的形状：继承在门外时附加根流进子级 scope，
    // 这条 Bash 会从拒变放行（bindRunScopedParams 按根判）。拒在工具查找之前，不真跑 shell。
    const result = await buildExecutor({ parentScope: explicitAdditionalRootScope(), boundary: 'absent' })
      .execute('Bash', { command: 'pwd', working_directory: extraRoot }, { sessionId: 'wsb-wt4-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('RUN_WORKSPACE_BOUNDARY');
  });

  it('开关关（false 态）：Bash working_directory 指父级附加根仍拒（缺省/false 两态都不得多根）', async () => {
    const result = await buildExecutor({ parentScope: explicitAdditionalRootScope(), boundary: false })
      .execute('Bash', { command: 'pwd', working_directory: extraRoot }, { sessionId: 'wsb-wt4-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('RUN_WORKSPACE_BOUNDARY');
  });

  it('开关关：worktree 根内写仍放行（原样返回 worktree 单根 scope，不是全拒）', async () => {
    // 另一面：收口不是把 scope 收没——单根 worktree scope 原样在，根内写照常。
    const target = path.join(worktree, 'wt4-inside-off.txt');
    const result = await buildExecutor({ parentScope: explicitAdditionalRootScope(), boundary: 'absent' })
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wt4-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('开关开着：附加根继承照常——附加根内 Write 放行且真落盘（门内行为不变）', async () => {
    const target = path.join(extraRoot, 'wt4-inherit-on.txt');
    const result = await buildExecutor({ parentScope: explicitAdditionalRootScope(), boundary: true })
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wt4-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});
