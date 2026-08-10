// ============================================================================
// 写边界宽度校验 — 基座 ToolExecutor（无 runContext）的 workingDirectory 回落
// ============================================================================
// 安全单 2026-08-09：语音派出的后台 run 把 $HOME 当「项目目录内」auto-approve，
// 文件真落盘、审批 0 次。真机账本指纹 = permission_classifier / auto-approve /
// 「写入项目目录内」(W1) ⇒ writeWorkspaceRoot 当时就是 $HOME。
// (b) 侧（scope 铸造）已在 createRunContext 源头被 workspaceAuthority 拦住；
// 本文件钉死 (a) 侧：无 runContext 的 executor 无条件把 workingDirectory 当写边界，
// home / 数据目录 / 祖先路径也能成为无人值守写边界。丙案要求这条回落必须过与
// delegate_task 前置预检同一份宽度校验（resolveBackgroundWorkspaceAuthority）。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Bash 动态描述会去请求模型 provider，与本测试无关，直接短路。
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';

describe('基座 ToolExecutor 写边界宽度校验（无 runContext 回落）', () => {
  let fakeHome: string;
  let prevHome: string | undefined;
  let permissionRequests: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'home-boundary-'));
    prevHome = process.env.CODE_AGENT_HOME;
    // workspaceAuthority 的 canonicalHomes 取 getHomeDir()（CODE_AGENT_HOME 优先），
    // 注入假 home 后它会把 fakeHome 当 home 拒掉——与真机 $HOME 同形状。
    process.env.CODE_AGENT_HOME = fakeHome;
    permissionRequests = [];
    getToolCache().clear();
    fileReadTracker.clear();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  function buildExecutor(workingDirectory: string, approve: boolean): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return approve;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it('workingDirectory=home 时，写 home 文件不得无审批自动放行（真机 FAIL 复现）', async () => {
    const executor = buildExecutor(fakeHome, false); // 审批一律拒：若分类正确该写就落不了盘
    const probe = path.join(fakeHome, 'boundary-probe.txt');
    const result = await executor.execute(
      'Write',
      { file_path: probe, content: 'neo-boundary-negative' },
      { sessionId: 'home-boundary-session' },
    );
    // 判据锚真实副作用 + 审批计数（安全单硬护栏 3）：
    // 修复前：W1「写入项目目录内」auto-approve，审批 0 次、文件真落盘 —— 本测试红。
    expect(permissionRequests.length).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    expect(existsSync(probe)).toBe(false);
  });

  it('正向：workingDirectory=具体项目目录时，写边界保持该目录（1914 个存量会话不误伤）', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legit-project-'));
    try {
      const executor = buildExecutor(projectDir, false);
      // 钉在 writeWorkspaceRoot 上（不经 W2 临时目录分支的干扰）：
      // 合法项目目录必须仍是写边界；home 必须不是。
      const writeRoot = (executor as unknown as { writeWorkspaceRoot?: string }).writeWorkspaceRoot;
      expect(writeRoot).toBeDefined();
      expect(path.resolve(writeRoot!)).toBe(await fs.realpath(projectDir));
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('负向：workingDirectory=home 时 writeWorkspaceRoot 必须为空（宽度校验判据与 delegate 预检同源）', () => {
    const executor = buildExecutor(fakeHome, false);
    const writeRoot = (executor as unknown as { writeWorkspaceRoot?: string }).writeWorkspaceRoot;
    expect(writeRoot).toBeUndefined();
  });
});
