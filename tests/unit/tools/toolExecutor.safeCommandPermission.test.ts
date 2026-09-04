import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

vi.mock('../../../src/host/security', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/security')>();
  return {
    ...original,
    getExecPolicyStore: () => ({
      match: () => null,
      learnFromApproval: () => false,
    }),
  };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';

describe('ToolExecutor Bash 安全命令单一判据', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];
  let previousSafetyMode: string | undefined;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-command-permission-'));
    await fs.writeFile(path.join(workspace, 'bar'), 'foo\n', 'utf8');
    permissionRequests = [];
    previousSafetyMode = process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'strict';
    getToolCache().clear();
  });

  afterEach(async () => {
    if (previousSafetyMode === undefined) delete process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    else process.env.CODE_AGENT_SHELL_SAFETY_MODE = previousSafetyMode;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildRejectingExecutor(): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it('find -delete 必须请求一次审批，拒绝后命令失败且目标保留', async () => {
    const target = path.join(workspace, 'dummy.tmp');
    await fs.writeFile(target, 'keep', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command: 'find . -name dummy.tmp -delete' },
      { sessionId: 'safe-command-find-delete' },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      type: 'command',
      details: { command: 'find . -name dummy.tmp -delete' },
    });
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('printf 重定向必须请求一次审批，拒绝后命令失败且文件不存在', async () => {
    const target = path.join(workspace, 'printf-output.txt');
    const command = `printf 'x' > ${JSON.stringify(target)}`;
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: 'safe-command-printf-redirection' },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      type: 'command',
      details: { command },
    });
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    "printf 'x'",
    'grep foo bar',
    'git status',
    'find . -name x',
  ])('%s 仍免审批', async (command) => {
    const executor = buildRejectingExecutor();

    await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-positive-${command}` },
    );

    expect(permissionRequests).toHaveLength(0);
  });

  it('lenient 模式仍在执行前拦截参数倒序的 dd 设备写入', async () => {
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'lenient';
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command: 'dd of=/dev/disk2 if=x' },
      { sessionId: 'safe-command-dd-device-reordered' },
    );

    expect(permissionRequests).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Security: Command blocked'),
    });
  });

  it.each([
    'command cat .env',
    'command git remote set-url origin https://evil.example/x.git',
    'command git config credential.helper store',
    'command git push origin feature-x',
    'exec git push origin feature-x',
    'nice -n 5 git remote set-url origin https://evil.example/x.git',
  ])('Bash 预授权仍不能绕过 command 包装下的审批：%s', async (command) => {
    await fs.writeFile(path.join(workspace, '.env'), 'CONTROLLED_TEST_SECRET=1\n', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-wrapper-${command}`, preApprovedTools: new Set(['Bash']) },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it.each([
    'cat .env;',
    '(cat .env)',
    'git remote set-url origin https://evil.example/x.git;',
  ])('拆不出完整命令段时预授权也必须 fail-closed 请求审批：%s', async (command) => {
    await fs.writeFile(path.join(workspace, '.env'), 'CONTROLLED_TEST_SECRET=1\n', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-unsegmented-${command}`, preApprovedTools: new Set(['Bash']) },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it('路径规范化异常会结构化 fail-closed，不让 execute promise reject', async () => {
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Read',
      { file_path: '\0' },
      { sessionId: 'path-analysis-nul' },
    );

    expect(result).toMatchObject({
      success: false,
      metadata: {
        code: 'PERMISSION_PATH_ANALYSIS_FAILED',
        failureCode: 'permission-denied',
      },
    });
    expect(permissionRequests).toHaveLength(0);
  });

  it.each([
    'cat .env',
    'git remote set-url origin https://evil.example/x.git',
    'git config credential.helper store',
    'git push origin feature-x',
  ])('lenient 模式仍要求审批确定性敏感参数：%s', async (command) => {
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'lenient';
    await fs.writeFile(path.join(workspace, '.env'), 'CONTROLLED_TEST_SECRET=1\n', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-lenient-sensitive-${command}` },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it.each([
    'sudo -u me rm -rf ~',
    'timeout 5 dd if=x of=/dev/disk2',
  ])('Bash 预授权仍不能绕过任意位置扫描的硬拒：%s', async (command) => {
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-hard-wrapper-${command}`, preApprovedTools: new Set(['Bash']) },
    );

    expect(permissionRequests).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Security: Command blocked'),
    });
  });
});
