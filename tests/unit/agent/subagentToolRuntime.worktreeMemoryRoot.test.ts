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
// worktree 分支 scope 重建），父级 scope 与评测 adapter 同源（真 buildEvalRunScoping
// 造 sandbox primary + eval-memory additional 双根），cwd 构造真实 agent worktree 路径
// （WORKTREE_BASE_DIR 下），判据锚真实落盘。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import { WORKTREE_BASE_DIR } from '../../../src/host/agent/agentWorktreePath';
import { buildEvalRunScoping } from '../../../src/host/testing/agentAdapter';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { WorkspaceScope } from '../../../src/shared/contract/project';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';
import type { ToolExecutor } from '../../../src/host/tools/toolExecutor';

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

  /** 父级 scope 与评测 adapter 完全同源：开着边界时 buildEvalRunScoping 造的双根 scope。 */
  function evalParentScope(): WorkspaceScope {
    const scoping = buildEvalRunScoping({
      restrictWritesToWorkspace: true,
      workingDirectory: sandbox,
      runId: 'wsb-wtmr-run',
      sessionId: 'wsb-wtmr-session',
    });
    if (!scoping.workspaceScope) throw new Error('buildEvalRunScoping did not derive a scope');
    return scoping.workspaceScope;
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
    const result = await buildWorktreeSubagentExecutor(evalParentScope())
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
    const result = await buildWorktreeSubagentExecutor(evalParentScope())
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-wtmr-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('worktree 子代理：worktree 根外且记忆根外仍拒且不落盘', async () => {
    const target = path.join(outside, 'wt-escape.txt');
    const result = await buildWorktreeSubagentExecutor(evalParentScope())
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
