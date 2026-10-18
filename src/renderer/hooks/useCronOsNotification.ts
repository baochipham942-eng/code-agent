import { useEffect, useRef } from 'react';
import { IPC_CHANNELS, type NotificationShowEvent } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import ipcService from '../services/ipcService';
import { translateCronOsNotification } from '../components/features/cron/cronFailureNotice';
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
          copy,
          useAppStore.getState().language,
        ));
      },
    );
    void registerNotificationClick(() => {
      const event = lastEventRef.current;
      const siteOrigin = event && cronLoginWallSiteOriginFromNotification(event);
      if (siteOrigin) openCronLoginWallSite(siteOrigin);
      const sessionId = lastSessionIdRef.current;
      if (sessionId) onOpenSession(sessionId);
    });
    return () => unsubscribe?.();
  }, [copy, onOpenSession]);
}
