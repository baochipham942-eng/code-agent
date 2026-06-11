import { describe, it, expect, vi } from 'vitest';
import { createCLIPermissionHandler } from '../../../src/cli/permissionPolicy';
import type { PermissionRequestData } from '../../../src/main/tools/types';

function makeRequest(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    type: 'command',
    tool: 'Bash',
    details: { command: 'ls' },
    ...overrides,
  };
}

describe('createCLIPermissionHandler', () => {
  it('approves normal tool permissions by default', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ type: 'file_write' }))).resolves.toBe(true);
    await expect(handler(makeRequest({ type: 'command' }))).resolves.toBe(true);
    await expect(handler(makeRequest({ type: 'network' }))).resolves.toBe(true);
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
    const handler = createCLIPermissionHandler({ warn });
    await handler(makeRequest());
    expect(warn).not.toHaveBeenCalled();
  });
});
