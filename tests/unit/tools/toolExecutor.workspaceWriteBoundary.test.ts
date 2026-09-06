// ============================================================================
// restrictWritesToWorkspace：写目标必须落在 workspaceScope 的可写根内
// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY：评测 scripted 审批策略只按 (tool, requestType) 裁决、
// 表达不了路径，`Write`/`Edit`/`Append` 一律无条件 allow ⇒ 模型把目标指到沙箱外就能
// 覆盖真实文件。修法不是给策略加语法，而是接通 ToolExecutor 已有的 workspaceScope 写闸，
// 并用 restrictWritesToWorkspace 把「scope 里找不到这个目标」也判成越界。
//
// 判据锚真实副作用（文件到底有没有落盘），不锚中间态。
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
import { createRunContext } from '../../../src/host/runtime/runContext';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

describe('restrictWritesToWorkspace 写边界', () => {
  let sandbox: string;
  let outside: string;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-sandbox-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-outside-')));
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    await fs.rm(sandbox, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function buildExecutor(restrict: boolean): ToolExecutor {
    const executor = new ToolExecutor({
      // 审批一律放行：本测试要证明的是「边界拦住了」，不是「审批拦住了」。
      // 审批放行还落不了盘，才说明拦它的确实是这道写边界。
      requestPermission: async () => true,
      workingDirectory: sandbox,
      restrictWritesToWorkspace: restrict,
      runContext: createRunContext({
        runId: 'wsb-run',
        sessionId: 'wsb-session',
        cwd: sandbox,
        workspaceScope: createWorkspaceScope('wsb-project', [{
          sourceId: 'sandbox-root', path: sandbox, access: 'read_write', role: 'primary',
        }]),
      }),
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  async function write(executor: ToolExecutor, filePath: string) {
    return executor.execute('Write', { file_path: filePath, content: 'wsb' }, { sessionId: 'wsb-session' });
  }

  it('沙箱内正常写：放行且真落盘', async () => {
    const target = path.join(sandbox, 'inside.txt');
    const result = await write(buildExecutor(true), target);
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('绝对路径逃逸：拒绝且文件不落盘', async () => {
    const target = path.join(outside, 'escape-abs.txt');
    const result = await write(buildExecutor(true), target);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('../ 逃逸：拒绝且文件不落盘', async () => {
    const target = path.join(sandbox, '..', path.basename(outside), 'escape-dotdot.txt');
    const result = await write(buildExecutor(true), target);
    expect(result.success).toBe(false);
    expect(existsSync(path.join(outside, 'escape-dotdot.txt'))).toBe(false);
  });

  it('软链逃逸：沙箱内的软链指向沙箱外，同样拒绝且不落盘', async () => {
    const link = path.join(sandbox, 'link-out');
    await fs.symlink(outside, link, 'dir');
    const target = path.join(link, 'escape-symlink.txt');
    const result = await write(buildExecutor(true), target);
    expect(result.success).toBe(false);
    expect(existsSync(path.join(outside, 'escape-symlink.txt'))).toBe(false);
  });

  it('开关关闭（生产缺省）时行为不变：scope 外的写不被这道闸拦', async () => {
    // 这条守的是「本单没顺手收紧生产」——生产会话带着 scope 往项目外写是正常路径。
    const target = path.join(outside, 'production-default.txt');
    const result = await write(buildExecutor(false), target);
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
  });
});
