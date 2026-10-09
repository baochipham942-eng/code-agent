import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';

const permissionMocks = vi.hoisted(() => ({
  unattended: false,
}));

vi.mock('../../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ isUnattendedSession: () => permissionMocks.unattended }),
}));

const terminalMocks = vi.hoisted(() => ({ note: vi.fn() }));
vi.mock('../../../../src/host/agent/unattendedApprovalTerminal', () => ({
  noteUnattendedRunTerminal: terminalMocks.note,
}));

import { enforceBrowserLoginWallStop } from '../../../../src/host/tools/vision/browserLoginWallGate';

function context(overrides: Partial<ToolContext> = {}): Pick<ToolContext, 'sessionId' | 'forceFinalResponse'> {
  return {
    sessionId: 'cron-session',
    forceFinalResponse: vi.fn(),
    ...overrides,
  };
}

describe('enforceBrowserLoginWallStop', () => {
  beforeEach(() => {
    permissionMocks.unattended = false;
    terminalMocks.note.mockReset();
  });

  it('keeps interactive sessions unchanged', async () => {
    const result = await enforceBrowserLoginWallStop({
      browserService: { getPageContent: vi.fn(async () => ({
        url: 'http://127.0.0.1:4123/login',
        title: 'Please sign in',
        text: 'Please sign in to continue',
        passwordInputPresent: true,
        loginFormPresent: true,
      })) },
      context: context(),
    });
    expect(result).toBeNull();
    expect(terminalMocks.note).not.toHaveBeenCalled();
  });

  it('returns a failed stop result and records the site origin for unattended runs', async () => {
    permissionMocks.unattended = true;
    const forceFinalResponse = vi.fn();
    const result = await enforceBrowserLoginWallStop({
      browserService: { getPageContent: vi.fn(async () => ({
        url: 'http://127.0.0.1:4123/login?next=1',
        title: 'Please sign in',
        text: 'Please sign in to continue',
        passwordInputPresent: true,
        loginFormPresent: true,
      })) },
      context: context({ forceFinalResponse }),
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('CRON_LOGIN_WALL_STOP|http://127.0.0.1:4123'),
      metadata: { code: 'CRON_LOGIN_WALL_STOP', siteOrigin: 'http://127.0.0.1:4123', stopRun: true },
    });
    expect(terminalMocks.note).toHaveBeenCalledWith('cron-session', 'CRON_LOGIN_WALL_STOP|http://127.0.0.1:4123');
    expect(forceFinalResponse).toHaveBeenCalledWith('cron-login-wall-stop', expect.stringContaining('127.0.0.1:4123'));
  });
});
