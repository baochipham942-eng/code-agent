// ============================================================================
// cli/commands/shellPassthrough.ts — `!` 直通唯一通道单测：
// 必须走 ToolExecutor 正式链路（execute('bash', { command })），executor
// 未初始化时 fail-closed，禁止退回 execSync 旁路。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executorState = vi.hoisted(() => ({
  execute: vi.fn(),
  available: true,
}));

vi.mock('../../../src/cli/bootstrap', () => ({
  getToolExecutor: () => (executorState.available ? { execute: executorState.execute } : null),
}));

import { runDirectShellCommand } from '../../../src/cli/commands/shellPassthrough';

describe('runDirectShellCommand', () => {
  beforeEach(() => {
    executorState.execute.mockReset();
    executorState.available = true;
  });

  it('走 ToolExecutor 正式链路：bash 工具 + command 参数', async () => {
    executorState.execute.mockResolvedValue({ success: true, output: 'ok' });
    const result = await runDirectShellCommand('ls -la');
    expect(executorState.execute).toHaveBeenCalledWith('bash', { command: 'ls -la' }, {});
    expect(result).toEqual({ success: true, output: 'ok' });
  });

  it('executor 未初始化时 fail-closed（不抛、不旁路）', async () => {
    executorState.available = false;
    const result = await runDirectShellCommand('ls');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('权限被拒/执行失败原样透传（denialSource 等证据由 executor 链路产出）', async () => {
    executorState.execute.mockResolvedValue({ success: false, error: 'Permission denied' });
    const result = await runDirectShellCommand('rm -rf /');
    expect(result).toEqual({ success: false, error: 'Permission denied' });
  });
});
