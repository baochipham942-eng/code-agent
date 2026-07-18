// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  setPendingPermissionRequest,
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  sidebarCollapsed: false,
  setShowDAGPanel: vi.fn(),
  showDAGPanel: false,
  setShowWorkspace: vi.fn(),
  showWorkspace: false,
  workbenchTabs: [] as string[],
  openWorkbenchTab: vi.fn(),
  closeWorkbenchTab: vi.fn(),
  setTaskPanelTab: vi.fn(),
  setShowCapturePanel: vi.fn(),
  setShowBrowserSurfacePanel: vi.fn(),
  setShowComputerUsePanel: vi.fn(),
  setShowFileExplorer: vi.fn(),
  openWorkspacePreview: vi.fn(),
  showSettings: false,
  isProcessing: false,
}));
const sessionState = vi.hoisted(() => ({
  currentSessionId: 'session-current',
  sessions: [{ id: 'session-current' }],
  isSessionRunning: vi.fn(() => false),
  moveToBackground: vi.fn(),
  createSession: vi.fn(),
  switchSession: vi.fn(),
  clearCurrentSession: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(() => appState, { getState: () => appState }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => sessionState,
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => ({ regenerateLast: vi.fn() }) },
}));
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({
    keybindings: {
      bindings: {
        'session.stop': { enabled: true, accelerator: 'Escape' },
      },
      globalHotkeysEnabled: false,
    },
    platform: 'darwin',
  }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => true,
    invoke,
    unsafeInvoke: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction: vi.fn(),
  isNativeCommandRuntimeAvailable: () => false,
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(),
}));

import { useKeyboardShortcuts } from '../../../src/renderer/hooks/useKeyboardShortcuts';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const request: PermissionRequest = {
  id: 'permission-escape',
  sessionId: 'request-session',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/report.txt' },
  timestamp: 1,
};

describe('useKeyboardShortcuts permission response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.pendingPermissionRequest = request;
    appState.pendingPermissionSessionId = 'session-current';
    invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
  });

  it('sends a deny response to the host when Escape closes a pending approval', async () => {
    renderHook(() => useKeyboardShortcuts());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        'deny',
        request.sessionId,
      );
    });
    expect(setPendingPermissionRequest).toHaveBeenCalledWith(null);
  });
});
