import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';
import {
  buildCronLoginWallStopCode,
  isBrowserLoginWall,
  parseCronLoginWallStop,
} from '../../../../src/shared/utils/browserLoginWall';

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

describe('isBrowserLoginWall', () => {
  it.each([
    ['password input', { passwordInputPresent: true, loginFormPresent: false }],
    ['login form', { passwordInputPresent: false, loginFormPresent: true }],
  ])('requires login copy plus %s evidence', (_label, fields) => {
    expect(isBrowserLoginWall({
      title: 'Please sign in to continue',
      headings: [],
      visibleText: 'Your account is required.',
      ...fields,
    })).toBe(true);
  });

  it('does not classify a page with only a login link or a password form without login copy', () => {
    expect(isBrowserLoginWall({
      title: 'Home',
      headings: ['Sign in'],
      visibleText: 'Welcome. Sign in to view your account.',
      passwordInputPresent: false,
      loginFormPresent: false,
    })).toBe(false);
    expect(isBrowserLoginWall({
      title: 'Checkout',
      headings: ['Password reset'],
      visibleText: 'Enter your password.',
      passwordInputPresent: true,
      loginFormPresent: true,
    })).toBe(false);
  });

  it('round-trips the login-wall stop code with only the site origin', () => {
    const code = buildCronLoginWallStopCode('https://example.test/account?next=1');
    expect(code).toBe('CRON_LOGIN_WALL_STOP|https://example.test');
    expect(parseCronLoginWallStop(`${code}; stop this unattended run`)).toEqual({
      siteOrigin: 'https://example.test',
    });
  });
});
