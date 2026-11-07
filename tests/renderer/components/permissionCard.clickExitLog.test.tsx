// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import type { DecisionCardProps } from '../../../src/renderer/components/DecisionCard';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  sessionId: null as string | null,
}));
const invoke = vi.hoisted(() => vi.fn());
const domainInvoke = vi.hoisted(() => vi.fn());
const saveMemory = vi.hoisted(() => vi.fn());
const dismissPermissionRequest = vi.hoisted(() => vi.fn());
const recordPermissionDecision = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const latestDirectAction = vi.hoisted(() => ({ current: null as (() => void) | null }));
const approvalCallback = vi.hoisted(() => ({ current: null as ((level: 'once') => Promise<void>) | null }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: ((callback: (...args: never[]) => unknown, deps: React.DependencyList) => {
      if (callback.toString().includes('claimApprovalResponse')) {
        approvalCallback.current = callback as (level: 'once') => Promise<void>;
      }
      return actual.useCallback(callback, deps);
    }) as typeof actual.useCallback,
  };
});

vi.mock('../../../src/renderer/components/DecisionCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/components/DecisionCard')>();
  return {
    ...actual,
    DecisionCard: ({ onDirectAction }: DecisionCardProps) => {
      latestDirectAction.current = () => onDirectAction?.('once');
      return <button type="button" onClick={() => onDirectAction?.('once')}>允许一次</button>;
    },
  };
});

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest: (request: PermissionRequest | null, sessionId: string | null) => {
      state.request = request;
      state.sessionId = sessionId;
    },
    dismissPermissionRequest,
    recordPermissionDecision,
    language: 'zh',
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke, invokeDomain: domainInvoke },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { claimApprovalResponse, releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const request: PermissionRequest = {
  id: 'permission-click-log',
  sessionId: 'session-current',
  tool: 'Bash',
  type: 'command',
  details: { command: 'CLICKLOG_CARD_COMMAND_SENTINEL' },
  timestamp: 1,
};

function confirmAllowOnce() {
  fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
}

async function expectSingleLog(stage: string, detail: unknown = '') {
  await waitFor(() => expect(domainInvoke).toHaveBeenCalledTimes(1));
  expect(domainInvoke).toHaveBeenCalledWith('domain:diagnostics', 'logClientError', {
    context: 'PermissionCard',
    message: `PermissionCard click exit: stage=${stage} requestId=permission-click-log sessionId=session-current`,
    detail,
  });
}

describe('PermissionCard click exit logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.request = request;
    state.sessionId = 'session-current';
    latestDirectAction.current = null;
    approvalCallback.current = null;
    invoke.mockResolvedValue(undefined);
    domainInvoke.mockResolvedValue({ success: true, data: undefined });
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
    vi.restoreAllMocks();
  });

  it('logs swallowed:no-request-or-settled exactly once from the real card callback', async () => {
    render(<PermissionCard requestOverride={{ ...request, resolved: true, decision: 'once' }} sessionIdOverride="session-current" />);

    expect(approvalCallback.current).not.toBeNull();
    await act(async () => approvalCallback.current?.('once'));

    await expectSingleLog('swallowed:no-request-or-settled');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('logs swallowed:already-processed exactly once on a second click while the first is pending', async () => {
    let resolveFirst!: (value: undefined) => void;
    invoke.mockReturnValueOnce(new Promise<undefined>((resolve) => {
      resolveFirst = resolve;
    }));
    render(<PermissionCard requestOverride={request} sessionIdOverride="session-current" />);

    confirmAllowOnce();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    confirmAllowOnce();

    await expectSingleLog('swallowed:already-processed');
    await act(async () => resolveFirst(undefined));
  });

  it('logs swallowed:claim-rejected exactly once when another surface owns the claim', async () => {
    expect(claimApprovalResponse(request.id)).toBe(true);
    render(<PermissionCard requestOverride={request} sessionIdOverride="session-current" />);

    confirmAllowOnce();

    await expectSingleLog('swallowed:claim-rejected');
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['rejecting', 'missing'] as const)('%s log channel preserves card-catch restore and toast', async (mode) => {
    const errorText = `offline-${'x'.repeat(320)}`;
    invoke.mockRejectedValueOnce(new Error(errorText));
    if (mode === 'rejecting') {
      domainInvoke.mockRejectedValueOnce(new Error('log channel rejected'));
    } else {
      domainInvoke.mockImplementationOnce(() => {
        throw new Error('log channel missing');
      });
    }
    render(<PermissionCard />);

    confirmAllowOnce();

    await expectSingleLog('card-catch', errorText.slice(0, 300));
    await waitFor(() => {
      expect(state.request).toEqual(request);
      expect(toastError).toHaveBeenCalledWith('审批响应发送失败，请重试');
    });
    expect(screen.getByRole('button', { name: '允许一次' })).toBeTruthy();
    expect(recordPermissionDecision).not.toHaveBeenCalled();
  });
});
