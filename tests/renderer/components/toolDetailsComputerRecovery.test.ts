import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
    }),
}));

import {
  ToolDetails,
  getBrowserComputerNextSteps,
} from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

const invokeMock = vi.fn();

function installDomainApi() {
  vi.stubGlobal('window', {
    domainAPI: {
      invoke: invokeMock,
    },
  });
}

function makeFailedComputerCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'computer_use',
    arguments: {
      action: 'smart_type',
      targetApp: 'Google Chrome',
      selector: '#email',
      text: 'secret@example.com',
    },
    result: {
      toolCallId: 'tool-1',
      success: false,
      error: 'No element found after secret@example.com',
      metadata: {
        code: 'COMPUTER_SURFACE_BLOCKED',
      },
    },
    ...overrides,
  };
}

describe('ToolDetails computer recovery actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installDomainApi();
  });

  it('renders read-only computer recovery actions without exposing typed text', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolDetails, {
        toolCall: makeFailedComputerCall(),
      }),
    );

    expect(html).toContain('browser-computer-next-step-action-open_desktop_status');
    expect(html).toContain('browser-computer-next-step-action-observe_current_window');
    expect(html).toContain('browser-computer-next-step-action-list_ax_candidates');
    expect(html).toContain('只读取 Computer Surface 状态');
    expect(html).toContain('只读取前台窗口和 Computer Surface 状态');
    expect(html).toContain('只读取 Google Chrome 的 Accessibility 候选');
    expect(html).toContain('不自动重试原动作');
    expect(html).not.toContain('secret@example.com');
  });

  it('executes only read-only desktop recovery IPC calls', async () => {
    invokeMock.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'getComputerSurfaceState') {
        return {
          success: true,
          data: {
            mode: 'foreground_fallback',
            targetApp: 'Google Chrome',
            requiresForeground: true,
            approvalScope: 'session_app',
          },
        };
      }
      if (action === 'observeComputerSurface') {
        return {
          success: true,
          data: {
            snapshot: {
              appName: 'Google Chrome',
              windowTitle: 'Docs',
            },
            state: {
              mode: 'foreground_fallback',
              requiresForeground: true,
            },
          },
        };
      }
      if (action === 'listComputerSurfaceElements') {
        return {
          success: true,
          data: {
            output: 'button Submit\ntextbox Email',
            metadata: {
              elements: [{ role: 'button' }, { role: 'textbox' }],
            },
          },
        };
      }
      return { success: false, error: { code: 'UNEXPECTED', message: action } };
    });

    const actions = getBrowserComputerNextSteps(makeFailedComputerCall());
    await actions.find((action) => action.id === 'open_desktop_status')?.run?.();
    await actions.find((action) => action.id === 'observe_current_window')?.run?.();
    await actions.find((action) => action.id === 'list_ax_candidates')?.run?.();

    expect(invokeMock).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'getComputerSurfaceState', {
      targetApp: 'Google Chrome',
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'observeComputerSurface', {
      includeScreenshot: false,
    });
    expect(invokeMock).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'listComputerSurfaceElements', {
      targetApp: 'Google Chrome',
      limit: 12,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC_DOMAINS.DESKTOP,
      expect.stringMatching(/click|type|retry/i),
      expect.anything(),
    );
  });

  it('routes browser-scoped computer_use failures to snapshot recovery', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      data: {
        domSnapshot: {
          capturedAtMs: Date.parse('2026-05-01T05:00:00.000Z'),
          headingCount: 1,
          interactiveCount: 3,
        },
        accessibilitySnapshot: {
          available: true,
        },
        recoveryEvidence: {
          snapshotCapturedAtMs: Date.parse('2026-05-01T05:00:00.000Z'),
        },
      },
    });

    const call = makeFailedComputerCall({
      arguments: {
        action: 'smart_type',
        selector: '#email',
        text: 'secret@example.com',
      },
    });
    const html = renderToStaticMarkup(
      React.createElement(ToolDetails, {
        toolCall: call,
      }),
    );
    const actions = getBrowserComputerNextSteps(call);

    expect(html).toContain('browser-computer-next-step-action-refresh_browser_snapshot');
    expect(html).toContain('读取 DOM / Accessibility snapshot');
    expect(html).not.toContain('browser-computer-next-step-action-open_desktop_status');
    expect(html).not.toContain('secret@example.com');

    const outcome = await actions.find((action) => action.id === 'refresh_browser_snapshot')?.run?.();

    expect(invokeMock).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'getManagedBrowserRecoverySnapshot', {
      includeAccessibility: true,
    });
    expect(outcome?.text).toContain('DOM headings: 1');
    expect(outcome?.text).toContain('Interactive elements: 3');
    expect(outcome?.text).toContain('Accessibility snapshot: available');
    expect(outcome?.text).toContain('Snapshot captured: 2026-05-01T05:00:00.000Z');
    expect(invokeMock).not.toHaveBeenCalledWith(
      IPC_DOMAINS.DESKTOP,
      expect.stringMatching(/click|type|retry|ComputerSurface/i),
      expect.anything(),
    );
  });

  it('requests managed browser recovery through system Chrome CDP provider', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      data: {
        provider: 'system-chrome-cdp',
      },
    });

    const actions = getBrowserComputerNextSteps({
      id: 'tool-2',
      name: 'browser_action',
      arguments: {
        action: 'navigate',
      },
      result: {
        toolCallId: 'tool-2',
        success: false,
        error: 'managed browser not running',
      },
    });

    await actions.find((action) => action.id === 'launch_managed_browser')?.run?.();

    expect(invokeMock).toHaveBeenCalledWith(IPC_DOMAINS.DESKTOP, 'ensureManagedBrowserSession', {
      url: 'about:blank',
      provider: 'system-chrome-cdp',
    });
  });
});
