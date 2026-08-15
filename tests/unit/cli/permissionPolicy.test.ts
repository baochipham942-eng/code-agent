import { describe, it, expect, vi } from 'vitest';
import { createCLIPermissionHandler } from '../../../src/cli/permissionPolicy';
import type { PermissionRequestData } from '../../../src/host/tools/types';

/** N-PERMTRACE：CLI/headless 拒的是「环境没有审批界面」，不是用户——处理器必须自报。 */
const DENIED_BY_ENV = { approved: false, denialSource: 'no-approval-ui' };

function makeRequest(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    type: 'command',
    tool: 'Bash',
    details: { command: 'ls' },
    ...overrides,
  };
}

describe('createCLIPermissionHandler', () => {
  it('denies every ask by default because CLI mode has no approval surface', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ type: 'file_write' }))).resolves.toEqual(DENIED_BY_ENV);
    await expect(handler(makeRequest({ type: 'command' }))).resolves.toEqual(DENIED_BY_ENV);
    await expect(handler(makeRequest({ type: 'network' }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies dangerous_command type in non-interactive mode', async () => {
    const handler = createCLIPermissionHandler();
    await expect(
      handler(makeRequest({ type: 'dangerous_command', details: { command: 'rm -rf /tmp/x' } })),
    ).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies requests flagged forceConfirm (需要人工确认)', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ forceConfirm: true }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies requests with dangerLevel danger', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ dangerLevel: 'danger' }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies an external file write when no person can answer the ask', async () => {
    const handler = createCLIPermissionHandler();

    await expect(handler(makeRequest({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/Users/linchen/boundary_probe.txt' },
      boundary: {
        id: 'file.external_write',
        reason: '写入文件内容会修改工作区外的目标路径。',
      },
    }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('approves everything when dangerouslySkipPermissions is set', async () => {
    const handler = createCLIPermissionHandler({ dangerouslySkipPermissions: true });
    await expect(handler(makeRequest({ type: 'dangerous_command' }))).resolves.toEqual({ approved: true });
    await expect(handler(makeRequest({ forceConfirm: true }))).resolves.toEqual({ approved: true });
    await expect(handler(makeRequest({ dangerLevel: 'danger' }))).resolves.toEqual({ approved: true });
  });

  it('emits a warning explaining the deny and the escape hatch', async () => {
    const warn = vi.fn();
    const handler = createCLIPermissionHandler({ warn });
    await handler(makeRequest({ type: 'dangerous_command', details: { command: 'rm -rf /' } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('--dangerously-skip-permissions');
  });

  it('does not warn on approvals', async () => {
    const warn = vi.fn();
    const handler = createCLIPermissionHandler({ warn, dangerouslySkipPermissions: true });
    await handler(makeRequest());
    expect(warn).not.toHaveBeenCalled();
  });
});
