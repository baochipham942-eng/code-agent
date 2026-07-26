import { useEffect } from 'react';
import { ipcService } from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';

/**
 * 永远挂载的 bridge：监听 main 端的 in-app validation 请求 → 写入 pending state，
 * 由评测中心「验证」tab 的 InAppValidationWorkspace 消费。
 *
 * 不抢占契约（2026-07 评测中心 v1，取代旧的 fixed 全屏强制弹 panel）：
 * - 评测中心未打开：openEvalCenter('validation') 把它请出来并落到验证 tab；
 * - 评测中心已打开：只写 pending，不切 tab、不打断用户——由 EvalCenterPage
 *   在验证 tab 上显示「新请求」角标；
 * - 用户有手动编辑时，workspace 的脏保护接管，请求挂起等用户选择加载/保留。
 */
export function useInAppValidationBridge(): void {
  const openEvalCenter = useAppStore((s) => s.openEvalCenter);
  const setPending = useAppStore((s) => s.setPendingInAppValidationRequest);

  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.IN_APP_VALIDATION_REQUEST,
      (request) => {
        setPending(request);
        if (!useAppStore.getState().showEvalCenter) {
          openEvalCenter('validation');
        }
      },
    );
    return () => unsubscribe?.();
  }, [openEvalCenter, setPending]);
}
