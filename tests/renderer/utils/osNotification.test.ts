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
    // 本文件是 node 环境（无 document）：焦点门控的安全访问视为"失焦"，
    // 既有发送路径用例不受影响；聚焦抑制由下面注入假 document 的用例覆盖。
    delete (globalThis as Record<string, unknown>).document;
    domainInvoke.mockResolvedValue({ success: true, data: null });
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);
    notificationPlugin.requestPermission.mockResolvedValue('granted');
  });

  it('suppresses the OS notification when the window is focused and visible', async () => {
    (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成', body: '不该弹' });

    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'suppressed-focused', dispatched: false },
    );
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
      { mode: 'tauri', granted: true, dispatched: true },
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
      { mode: 'tauri', granted: false, dispatched: false },
    );
  });

  // urgent（失败类）× 焦点 2x2：只有 focused+非 urgent 被抑制
  it.each([
    { urgent: true, focused: true, sent: true },
    { urgent: true, focused: false, sent: true },
    { urgent: false, focused: true, sent: false },
    { urgent: false, focused: false, sent: true },
  ])('urgent=$urgent focused=$focused → dispatched=$sent', async ({ urgent, focused, sent }) => {
    (globalThis as Record<string, unknown>).document = { hasFocus: () => focused, hidden: false };
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
    // resetModules 后 osNotification 用的是新 store 实例，需同批动态取真实 store
    const { useToastStore } = await import('../../../src/renderer/hooks/useToast');

    const onOpen = vi.fn();
    await postOsNotification({ title: 't', body: 'b' }, { urgent, onOpen, openLabel: '查看' });

    // 应用内 toast 只在 urgent+聚焦时出现，恰好一条且带动作按钮
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(urgent && focused ? 1 : 0);
    if (urgent && focused) {
      expect(toasts[0]).toMatchObject({ type: 'error', message: 't: b', duration: 10000, action: { label: '查看' } });
      toasts[0].action!.onClick();
      expect(onOpen).toHaveBeenCalledTimes(1);
    }

    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      sent
        ? { mode: 'tauri', granted: true, dispatched: true, ...(urgent ? { urgent: true } : {}), ...(urgent && focused ? { toastShown: true } : {}) }
        : { mode: 'suppressed-focused', dispatched: false },
    );
  });
});
