// @vitest-environment jsdom
import React from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeybindingActionId } from '../../../src/shared/keybindings';

const dial = vi.hoisted(() => vi.fn());
const hangUp = vi.hoisted(() => vi.fn());
const invokeNativeCommandAction = vi.hoisted(() => vi.fn());
const listenerState = vi.hoisted(() => ({
  callback: null as null | ((event: { payload: { actionId: KeybindingActionId; accelerator: string } }) => void),
}));
const voiceState = vi.hoisted(() => ({ phase: 'idle' as 'idle' | 'connecting' | 'live' | 'error' }));

const appState = vi.hoisted(() => ({
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  setPendingPermissionRequest: vi.fn(),
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
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: () => sessionState }));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => ({ regenerateLast: vi.fn() }) },
}));
vi.mock('../../../src/renderer/stores/voiceCallStore', () => ({
  useVoiceCallStore: { getState: () => voiceState },
}));
vi.mock('../../../src/renderer/services/voiceCallBridge', () => ({
  voiceCallBridge: { dial, hangUp },
}));
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({
    keybindings: {
      bindings: {
        'voice.callToggle': { enabled: true, accelerator: 'Cmd+Shift+V' },
      },
      globalHotkeysEnabled: true,
    },
    platform: 'darwin',
  }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn(), unsafeInvoke: vi.fn() },
}));
vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction,
  isNativeCommandRuntimeAvailable: () => true,
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_eventName, callback) => {
    listenerState.callback = callback;
    return vi.fn();
  }),
}));

import { useKeyboardShortcuts } from '../../../src/renderer/hooks/useKeyboardShortcuts';

async function triggerVoiceHotkey(): Promise<void> {
  await waitFor(() => expect(listenerState.callback).not.toBeNull());
  listenerState.callback?.({
    payload: {
      actionId: 'voice.callToggle' as KeybindingActionId,
      accelerator: 'Cmd+Shift+V',
    },
  });
}

describe('voice.callToggle global hotkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenerState.callback = null;
    voiceState.phase = 'idle';
    invokeNativeCommandAction.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it('dials through the existing bridge after Rust releases the focused-window event', async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    renderHook(() => useKeyboardShortcuts());

    await triggerVoiceHotkey();

    await waitFor(() => expect(dial).toHaveBeenCalledWith('session-current'));
    expect(hangUp).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('hangs up through the same bridge used by the in-window close button', async () => {
    voiceState.phase = 'live';
    renderHook(() => useKeyboardShortcuts());

    await triggerVoiceHotkey();

    await waitFor(() => expect(hangUp).toHaveBeenCalledTimes(1));
    expect(dial).not.toHaveBeenCalled();
  });
});
