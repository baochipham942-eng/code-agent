import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMacOSAppIcon,
  getNativeDesktopCapabilities,
  invokeNativeDesktopAction,
  isNativeDesktopAvailable,
  listRecentNativeDesktopEvents,
  openNativeDesktopSystemSettings,
  startNativeDesktopCollector,
} from '../../../src/renderer/services/nativeDesktop';

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

describe('nativeDesktop facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTauriWindow();
    tauriInvoke.mockResolvedValue({});
  });

  it('maps stable native desktop actions to Tauri commands inside the service boundary', async () => {
    await invokeNativeDesktopAction('getCapabilities');
    expect(tauriInvoke).toHaveBeenLastCalledWith('desktop_get_capabilities', undefined);

    await getNativeDesktopCapabilities();
    expect(tauriInvoke).toHaveBeenLastCalledWith('desktop_get_capabilities', undefined);

    await getMacOSAppIcon('Safari');
    expect(tauriInvoke).toHaveBeenLastCalledWith('desktop_get_app_icon', { query: 'Safari', size: 64 });

    await startNativeDesktopCollector({ intervalSecs: 30, captureScreenshots: true });
    expect(tauriInvoke).toHaveBeenLastCalledWith('desktop_start_collector', {
      request: { intervalSecs: 30, captureScreenshots: true },
    });

    await listRecentNativeDesktopEvents();
    expect(tauriInvoke).toHaveBeenLastCalledWith('desktop_list_recent_events', { limit: 8 });

    await openNativeDesktopSystemSettings('microphone');
    expect(tauriInvoke).toHaveBeenLastCalledWith('desktop_open_system_settings', {
      request: { kind: 'microphone' },
    });
  });

  it('keeps Tauri availability behind the facade', async () => {
    expect(isNativeDesktopAvailable()).toBe(true);
    (globalThis as Record<string, unknown>).window = {};

    expect(isNativeDesktopAvailable()).toBe(false);
    await expect(invokeNativeDesktopAction('getPermissionStatus')).rejects.toThrow('Tauri runtime not available');
  });
});
