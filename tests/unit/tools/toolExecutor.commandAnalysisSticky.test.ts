import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';

describe('ToolExecutor 解析失败会话粘性 fail-closed', () => {
  let workspace: string;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    resetPermissionModeManager();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'command-analysis-sticky-'));
  });

  afterEach(async () => {
    resetPermissionModeManager();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const createExecutor = (permissionEvents: PermissionRequestData[]) => {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionEvents.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  };

  it('同指纹第二次在 permission_request 边界前拒绝，不同会话仍独立首报', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = createExecutor(permissionEvents);
    const command = "printf 'unterminated";

    const first = await executor.execute('Bash', { command }, { sessionId: 'sticky-session-a' });
    expect(first).toMatchObject({ success: false });
    expect(first.error).toContain('不能从当前会话审批放行');
    expect(permissionEvents).toHaveLength(1);

    const repeated = await executor.execute('Bash', { command }, { sessionId: 'sticky-session-a' });
    expect(repeated).toMatchObject({
      success: false,
      metadata: { code: 'COMMAND_ANALYSIS_STICKY_DENY' },
    });
    expect(permissionEvents).toHaveLength(1);

    const otherSession = await executor.execute('Bash', { command }, { sessionId: 'sticky-session-b' });
    expect(otherSession).toMatchObject({ success: false });
    expect(permissionEvents).toHaveLength(2);
  });

  it('首次拒绝文案保留 fail-closed 句、去掉会话外手工死路、给出两条出路', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = createExecutor(permissionEvents);

    const first = await executor.execute('Bash', { command: "printf 'unterminated" }, { sessionId: 'first-text' });
    expect(first).toMatchObject({ success: false });
    expect(first.error).toContain('不能从当前会话审批放行');
    expect(first.error).not.toContain('只能由用户在会话外手工运行');
    // Exit (A): rewrite as plain simple commands
    expect(first.error).toContain('rewrite it as plain simple commands');
    expect(first.error).toContain('no command substitution');
    expect(first.error).toContain('prefer read-only');
    // Exit (B): stop and report instead of retrying
    expect(first.error).toContain('report the intent, the exact command and why it was blocked');
    expect(first.error).toContain('AskUserQuestion');
    expect(first.error).toContain('do not retry');
  });

  it('二次拒绝走 sticky 分支，文案要求停手挂起并给摘要，审批 mock 不再被调用', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = createExecutor(permissionEvents);
    const command = "printf 'unterminated";

    await executor.execute('Bash', { command }, { sessionId: 'park-session' });
    const repeated = await executor.execute('Bash', { command }, { sessionId: 'park-session' });

    expect(repeated).toMatchObject({
      success: false,
      metadata: { code: 'COMMAND_ANALYSIS_STICKY_DENY' },
    });
    expect(repeated.error).toContain('already denied in this session');
    expect(repeated.error).toContain('park it');
    expect(repeated.error).toContain('goal, command, why blocked, what was already tried');
    expect(repeated.error).toContain('independent work or end the turn');
    expect(permissionEvents).toHaveLength(1);
  });

  it('无人值守会话同命令三连：第二、三次都是 sticky 拒绝，审批 mock 总共只调一次', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = createExecutor(permissionEvents);
    getPermissionModeManager().markUnattendedSession('unattended-s');
    const command = "printf 'unterminated";

    const first = await executor.execute('Bash', { command }, { sessionId: 'unattended-s' });
    const second = await executor.execute('Bash', { command }, { sessionId: 'unattended-s' });
    const third = await executor.execute('Bash', { command }, { sessionId: 'unattended-s' });

    expect(first).toMatchObject({ success: false });
    for (const result of [second, third]) {
      expect(result).toMatchObject({
        success: false,
        metadata: { code: 'COMMAND_ANALYSIS_STICKY_DENY' },
      });
      expect(result.error).toContain('park it');
    }
    expect(permissionEvents).toHaveLength(1);
  });

  it('同一命令的空白变体经 canonicalCommand 归一后同指纹，直接 sticky 拒绝', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = createExecutor(permissionEvents);

    const first = await executor.execute('Bash', { command: "printf 'unterminated" }, { sessionId: 'ws-session' });
    expect(first).toMatchObject({ success: false });
    expect(permissionEvents).toHaveLength(1);

    // canonicalizeCommand 折叠连续空白并去引号，空白变体指纹相同。
    const variant = await executor.execute('Bash', { command: "printf   'unterminated" }, { sessionId: 'ws-session' });
    expect(variant).toMatchObject({
      success: false,
      metadata: { code: 'COMMAND_ANALYSIS_STICKY_DENY' },
    });
    expect(permissionEvents).toHaveLength(1);
  });

  it('拒绝判决不变：审批回调返回 true 也不执行；同会话可解析命令不受影响', async () => {
    const permissionEvents: PermissionRequestData[] = [];
    const executor = createExecutor(permissionEvents);

    const denied = await executor.execute('Bash', { command: "printf 'unterminated" }, { sessionId: 'decision-session' });
    expect(denied).toMatchObject({ success: false });

    const allowed = await executor.execute('Bash', { command: 'echo hello' }, { sessionId: 'decision-session' });
    expect(allowed).toMatchObject({ success: true });
  });
});
