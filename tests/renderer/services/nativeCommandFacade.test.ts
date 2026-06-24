import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invokeNativeCommandAction,
  isNativeCommandRuntimeAvailable,
} from '../../../src/renderer/services/nativeCommandFacade';

const tauriInvoke = vi.fn();

function installTauriWindow(): void {
  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      invoke: tauriInvoke,
      metadata: {
        currentWebview: { windowLabel: 'main', label: 'main' },
        currentWindow: { label: 'main' },
      },
    },
  };
}

describe('nativeCommandFacade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTauriWindow();
    tauriInvoke.mockResolvedValue(true);
  });

  it('maps appshots, pip, and keybinding actions to Rust commands in one place', async () => {
    await invokeNativeCommandAction('triggerAppshot');
    expect(tauriInvoke).toHaveBeenLastCalledWith('appshots_trigger', undefined);

    await invokeNativeCommandAction('readAppshotImageDataUrl', { path: '/tmp/capture.png' });
    expect(tauriInvoke).toHaveBeenLastCalledWith('appshots_read_image_data_url', { path: '/tmp/capture.png' });

    await invokeNativeCommandAction('reportAppshotComposerSlot', {
      slot: { x: 1, y: 2, width: 56, height: 56 },
    });
    expect(tauriInvoke).toHaveBeenLastCalledWith('appshots_report_composer_slot', {
      slot: { x: 1, y: 2, width: 56, height: 56 },
    });

    await invokeNativeCommandAction('setAppshotsEnabled', { enabled: false });
    expect(tauriInvoke).toHaveBeenLastCalledWith('appshots_set_enabled', { enabled: false });

    await invokeNativeCommandAction('showPip');
    expect(tauriInvoke).toHaveBeenLastCalledWith('pip_show', undefined);

    await invokeNativeCommandAction('framePip', { dataUrl: 'data:image/png;base64,abc' });
    expect(tauriInvoke).toHaveBeenLastCalledWith('pip_frame', { dataUrl: 'data:image/png;base64,abc' });

    await invokeNativeCommandAction('hidePip');
    expect(tauriInvoke).toHaveBeenLastCalledWith('pip_hide', undefined);

    await invokeNativeCommandAction('setGlobalHotkeys', {
      bindings: [{ actionId: 'app.quickAsk', accelerator: 'CmdOrCtrl+Shift+A' }],
    });
    expect(tauriInvoke).toHaveBeenLastCalledWith('keybindings_set_global_hotkeys', {
      bindings: [{ actionId: 'app.quickAsk', accelerator: 'CmdOrCtrl+Shift+A' }],
    });
  });

  it('reports unavailable Tauri runtime before invoking native commands', async () => {
    expect(isNativeCommandRuntimeAvailable()).toBe(true);
    (globalThis as Record<string, unknown>).window = {};

    expect(isNativeCommandRuntimeAvailable()).toBe(false);
    await expect(invokeNativeCommandAction('triggerAppshot')).rejects.toThrow('Tauri runtime not available');
  });
});
