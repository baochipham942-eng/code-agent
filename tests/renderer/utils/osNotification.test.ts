import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const notificationPlugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}));

const domainInvoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-notification', () => notificationPlugin);

function installTauriWindow(): void {
  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {},
    domainAPI: {
      invoke: domainInvoke,
    },
  };
}

describe('osNotification', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installTauriWindow();
    domainInvoke.mockResolvedValue({ success: true, data: null });
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);
    notificationPlugin.requestPermission.mockResolvedValue('granted');
  });

  it('sends task notifications through the Tauri notification plugin', async () => {
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

    expect(notificationPlugin.sendNotification).toHaveBeenCalledWith({
      title: '任务完成 - 循环',
      body: '已完成 1 轮',
    });
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'tauri', granted: true, sent: true },
    );
  });

  it('does not report a sent notification when native permission is denied', async () => {
    notificationPlugin.isPermissionGranted.mockResolvedValue(false);
    notificationPlugin.requestPermission.mockResolvedValue('denied');
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'tauri', granted: false, sent: false },
    );
  });
});
