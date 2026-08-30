import { useEffect } from 'react';
import { ipcService } from '@renderer/services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '@renderer/stores/appStore';

/**
 * 永远挂载的 bridge：监听 main 端的 in-app validation 请求 → 写入 pending state，
 * 由主干的 InAppValidationWorkspace 消费；这条链路也被 browser-control 工具复用，
 * 不得随评测中心内部包一起卸载。
 *
 * 不抢占契约（2026-07 评测中心 v1，取代旧的 fixed 全屏强制弹 panel）：
 * - 验证工作台未打开：打开主干验证面；
 * - 已打开：只更新 pending，不额外导航；
 * - 用户有手动编辑时，workspace 的脏保护接管，请求挂起等用户选择加载/保留。
 */
export function useInAppValidationBridge(): void {
  const setShowInAppValidation = useAppStore((s) => s.setShowInAppValidation);
  const setPending = useAppStore((s) => s.setPendingInAppValidationRequest);

  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.IN_APP_VALIDATION_REQUEST,
      (request) => {
        setPending(request);
        if (!useAppStore.getState().showInAppValidation) {
          setShowInAppValidation(true);
        }
      },
    );
    return () => unsubscribe?.();
  }, [setPending, setShowInAppValidation]);
}
