import { useEffect } from 'react';
import { ipcService } from '../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';

/**
 * 永远挂载的 bridge：监听 main 端的 in-app validation 请求 →
 * 强制打开 panel + 把请求放进 pending state，由 panel 消费。
 */
export function useInAppValidationBridge(): void {
  const setShow = useAppStore((s) => s.setShowInAppValidationPanel);
  const setPending = useAppStore((s) => s.setPendingInAppValidationRequest);

  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.IN_APP_VALIDATION_REQUEST,
      (request) => {
        setShow(true);
        setPending(request);
      },
    );
    return () => unsubscribe?.();
  }, [setShow, setPending]);
}
