import { describe, it, expect, vi } from 'vitest';
import { createCLIPermissionHandler } from '../../../src/cli/permissionPolicy';
import type { PermissionRequestData } from '../../../src/host/tools/types';

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
    await expect(handler(makeRequest({ type: 'file_write' }))).resolves.toBe(false);
    await expect(handler(makeRequest({ type: 'command' }))).resolves.toBe(false);
    await expect(handler(makeRequest({ type: 'network' }))).resolves.toBe(false);
  });

  it('denies dangerous_command type in non-interactive mode', async () => {
    const handler = createCLIPermissionHandler();
    await expect(
      handler(makeRequest({ type: 'dangerous_command', details: { command: 'rm -rf /tmp/x' } })),
    ).resolves.toBe(false);
  });

  it('denies requests flagged forceConfirm (需要人工确认)', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ forceConfirm: true }))).resolves.toBe(false);
  });

  it('denies requests with dangerLevel danger', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ dangerLevel: 'danger' }))).resolves.toBe(false);
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
    }))).resolves.toBe(false);
  });

  it('approves everything when dangerouslySkipPermissions is set', async () => {
    const handler = createCLIPermissionHandler({ dangerouslySkipPermissions: true });
    await expect(handler(makeRequest({ type: 'dangerous_command' }))).resolves.toBe(true);
    await expect(handler(makeRequest({ forceConfirm: true }))).resolves.toBe(true);
    await expect(handler(makeRequest({ dangerLevel: 'danger' }))).resolves.toBe(true);
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
