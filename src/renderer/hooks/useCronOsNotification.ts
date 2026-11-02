import { useEffect, useRef } from 'react';
import { IPC_CHANNELS, type NotificationShowEvent } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useCronStore } from '../stores/cronStore';
import ipcService from '../services/ipcService';
import {
  cronFailureCloudDownJobId,
  translateCronOsNotification,
} from '../components/features/cron/cronFailureNotice';
import {
  cronLoginWallSiteOriginFromNotification,
  openCronLoginWallSite,
} from '../components/features/cron/cronLoginWallNotice';
import { postOsNotification, registerNotificationClick } from '../utils/osNotification';

type CronNotificationCopy = Parameters<typeof translateCronOsNotification>[1];

export function useCronOsNotification(
  copy: CronNotificationCopy,
  onOpenSession: (sessionId: string) => void,
): void {
  const copyRef = useRef(copy);
  const onOpenSessionRef = useRef(onOpenSession);
  copyRef.current = copy;
  onOpenSessionRef.current = onOpenSession;
  const lastSessionIdRef = useRef<string | null>(null);
  const lastEventRef = useRef<NotificationShowEvent | null>(null);

  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      (event: NotificationShowEvent) => {
        lastSessionIdRef.current = event.sessionId;
        lastEventRef.current = event;
        void postOsNotification(translateCronOsNotification(
          event,
          copyRef.current,
          useAppStore.getState().language,
        ), { urgent: event.urgent === true });
      },
    );
    let disposed = false;
    let unregister: (() => Promise<void>) | undefined;
    void registerNotificationClick(() => {
      const event = lastEventRef.current;
      // The native notification is a consent boundary only for login-wall stops;
      // other cron notifications must never grant browser pass-through.
      const siteOrigin = event && cronLoginWallSiteOriginFromNotification(event);
      if (siteOrigin) openCronLoginWallSite(siteOrigin, event?.jobId);
      const sessionId = lastSessionIdRef.current;
      if (sessionId) onOpenSessionRef.current(sessionId);
      // 云端调度器不可用的失败没有本地会话：点击落 Cron Center 并选中该任务，
      // 详情里就是这句人话和「立即重跑」——不然这次点击只是把 app 带到前台。
      const cloudDownJobId = cronFailureCloudDownJobId(event);
      if (cloudDownJobId) {
        useCronStore.getState().selectJob(cloudDownJobId);
        useAppStore.getState().setShowCronCenter(true);
      }
    }).then((cleanup) => {
      if (disposed) {
        void cleanup?.();
      } else {
        unregister = cleanup;
      }
    });
    return () => {
      disposed = true;
      unsubscribe?.();
      void unregister?.();
    };
  }, []);
}
