// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE · 打开后的行为（真执行器，判据锚真实落盘）
// ============================================================================
// buildEvalRunScoping 是 adapter 的单一实现（agentAdapter.ts 导出，sendMessage 同款调用），
// 这里用真 ToolExecutor 跑它的产物：
// - 沙箱内写/记忆写：放行且真落盘（合法写入目的地不被误伤 = 无假阴性）
// - 绝对路径/软链逃逸：拒绝且不落盘
// - Bash working_directory 越界：开着拒（RUN_WORKSPACE_BOUNDARY，注入 scope 后的有意行为）；
//   关着**不拒**——这是 #1686 第五轮形状的行为面（关着 ⇒ 没注入 scope ⇒ Bash 边界不亮）
// - CODE_AGENT_DATA_DIR 在沙箱内：单根，评测起不来那种抛必须不存在
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { buildEvalRunScoping } from '../../../src/host/testing/agentAdapter';

describe('评测写边界（buildEvalRunScoping + 真 ToolExecutor）', () => {
  let parent: string;
  let sandbox: string;
  let outside: string;
  let dataDir: string;
  let memoryDir: string;
  const cleanupRoots: string[] = [];
  let previousDataDir: string | undefined;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-behave-')));
    cleanupRoots.push(parent);
    sandbox = path.join(parent, 'a-sandbox');
    outside = path.join(parent, 'z-outside');
    dataDir = path.join(parent, 'data');
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    await fs.mkdir(dataDir);
    memoryDir = path.join(dataDir, 'memory');
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    for (const root of cleanupRoots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /** 与 adapter.sendMessage 完全同款的构造（少 telemetry/spawn 等与边界无关项）。 */
  function buildExecutor(restrict: boolean): ToolExecutor {
    const scoping = buildEvalRunScoping({
      restrictWritesToWorkspace: restrict,
      workingDirectory: sandbox,
      runId: 'wsb-behave-run',
      sessionId: 'wsb-behave-session',
    });
    const executor = new ToolExecutor({
      // 审批一律放行：要证明的是「边界拦住了」，不是「审批拦住了」。
      requestPermission: async () => true,
      workingDirectory: scoping.runContext ? scoping.runContext.cwd : sandbox,
      ledgerOrigin: 'eval',
      ...(scoping.runContext ? {
        restrictWritesToWorkspace: true,
        runContext: scoping.runContext,
      } : {}),
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it('开着：沙箱内写放行且真落盘', async () => {
    const target = path.join(sandbox, 'inside.txt');
    const result = await buildExecutor(true)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-behave-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('开着：绝对路径逃逸拒绝且不落盘', async () => {
    const target = path.join(outside, 'escape-abs.txt');
    const result = await buildExecutor(true)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-behave-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开着：沙箱内软链指向沙箱外，写软链路径同样拒绝且不落盘', async () => {
    const link = path.join(sandbox, 'link-out');
    await fs.symlink(outside, link, 'dir');
    const target = path.join(link, 'escape-symlink.txt');
    const result = await buildExecutor(true)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-behave-session' });
    expect(result.success).toBe(false);
    expect(existsSync(path.join(outside, 'escape-symlink.txt'))).toBe(false);
  });

  it('开着：MemoryWrite 落进记忆目录（第二可写根）放行且真落盘', async () => {
    const result = await buildExecutor(true)
      .execute('MemoryWrite', {
        action: 'write',
        filename: 'wsb-memory.md',
        name: 'wsb',
        description: 'wsb write-boundary memory write',
        type: 'project',
        content: 'written by write-boundary behavior test',
      }, { sessionId: 'wsb-behave-session' });
    expect(result.success).toBe(true);
    // 判据锚真实副作用：记忆文件真的写进了 <CODE_AGENT_DATA_DIR>/memory/
    expect(existsSync(path.join(memoryDir, 'wsb-memory.md'))).toBe(true);
  });

  it('开着：Bash working_directory 越界被拒（注入 scope 后的有意行为）', async () => {
    const result = await buildExecutor(true)
      .execute('Bash', { command: 'ls', working_directory: outside }, { sessionId: 'wsb-behave-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('RUN_WORKSPACE_BOUNDARY');
  });

  it('🔴 关着：Bash working_directory 指到沙箱外**不拒**——不注入 scope ⇒ Bash 边界不亮（#1686 第五轮形状）', async () => {
    // 这条是验收④的行为面：开关关着时 runContext 不带 scope，挂在 scope 上的
    // RUN_WORKSPACE_BOUNDARY 必须不亮；亮了就是正常只读调用被拒 ⇒ 假阴性。
    const result = await buildExecutor(false)
      .execute('Bash', { command: 'ls', working_directory: outside }, { sessionId: 'wsb-behave-session' });
    expect(result.metadata?.code).not.toBe('RUN_WORKSPACE_BOUNDARY');
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
  });

  it('🔴 关着：沙箱外写不被这道闸拦（生产缺省行为，机制测试同款钉）', async () => {
    const target = path.join(outside, 'off-escape.txt');
    const result = await buildExecutor(false)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-behave-session' });
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
  });

  it('CODE_AGENT_DATA_DIR 在沙箱内：单根不抛，记忆写仍放行（写在沙箱内的记忆目录里）', async () => {
    // #1686 第三轮：重叠时不加记忆根。记忆目录此时在沙箱内 ⇒ 单根即可放行记忆写。
    const innerDataDir = path.join(sandbox, '.data');
    await fs.mkdir(path.join(innerDataDir, 'memory'), { recursive: true });
    process.env.CODE_AGENT_DATA_DIR = innerDataDir;
    try {
      const scoping = buildEvalRunScoping({
        restrictWritesToWorkspace: true,
        workingDirectory: sandbox,
        runId: 'wsb-overlap-run',
        sessionId: 'wsb-behave-session',
      });
      expect(scoping.workspaceScope?.roots.map((root) => root.sourceId)).toEqual(['eval-sandbox']);
      const executor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: scoping.runContext!.cwd,
        ledgerOrigin: 'eval',
        restrictWritesToWorkspace: true,
        runContext: scoping.runContext,
      });
      executor.setAuditEnabled(false);
      const result = await executor.execute('MemoryWrite', {
        action: 'write',
        filename: 'wsb-overlap.md',
        name: 'wsb',
        description: 'overlap memory write',
        type: 'project',
        content: 'overlap',
      }, { sessionId: 'wsb-behave-session' });
      expect(result.success).toBe(true);
      expect(existsSync(path.join(innerDataDir, 'memory', 'wsb-overlap.md'))).toBe(true);
    } finally {
      process.env.CODE_AGENT_DATA_DIR = dataDir;
    }
  });
});
