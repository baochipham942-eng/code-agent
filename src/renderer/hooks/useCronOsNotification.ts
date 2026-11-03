import { useEffect, useRef } from 'react';
import { IPC_CHANNELS, type NotificationShowEvent } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useCronStore } from '../stores/cronStore';
import { useSessionStore } from '../stores/sessionStore';
import { toast } from './useToast';
import { createMissedAlertQueue } from './missedAlertsOnReturn';
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

const MISSED_ALERT_TOAST_MS = 10_000;

function windowAttended(): boolean {
  return document.hasFocus() && !document.hidden;
}

type CronNotificationCopy = Parameters<typeof translateCronOsNotification>[1];

export function useCronOsNotification(
  copy: CronNotificationCopy,
  onOpenSession: (sessionId: string) => void,
): void {
  const copyRef = useRef(copy);
  const onOpenSessionRef = useRef(onOpenSession);
  copyRef.current = copy;
  onOpenSessionRef.current = onOpenSession;
  const lastEventRef = useRef<NotificationShowEvent | null>(null);

  const missedRef = useRef(createMissedAlertQueue());

  useEffect(() => {
    // 原生点击读「最近一条」事件；toast 动作必须绑定自己那条，否则连续两条失败时点 A 会开 B。
    const openForEvent = (event: NotificationShowEvent | null) => {
      // The native notification is a consent boundary only for login-wall stops;
      // other cron notifications must never grant browser pass-through.
      const siteOrigin = event && cronLoginWallSiteOriginFromNotification(event);
      if (siteOrigin) openCronLoginWallSite(siteOrigin, event?.jobId);
      const sessionId = event?.sessionId;
      if (sessionId) onOpenSessionRef.current(sessionId);
      // 云端调度器不可用的失败没有本地会话：点击落 Cron Center 并选中该任务，
      // 详情里就是这句人话和「立即重跑」——不然这次点击只是把 app 带到前台。
      const cloudDownJobId = cronFailureCloudDownJobId(event);
      if (cloudDownJobId) {
        useCronStore.getState().selectJob(cloudDownJobId);
        useAppStore.getState().setShowCronCenter(true);
      }
    };
    const openFromNotification = () => openForEvent(lastEventRef.current);
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      (event: NotificationShowEvent) => {
        lastEventRef.current = event;
        missedRef.current.record(event, windowAttended());
        void postOsNotification(translateCronOsNotification(
          event,
          copyRef.current,
          useAppStore.getState().language,
        ), {
          urgent: event.urgent === true,
          failure: event.failure === true,
          onOpen: () => openForEvent(event),
          openLabel: copyRef.current.failureToastView,
        });
      },
    );
    // 回到前台：把离开期间攒下的 urgent 提醒合成一条可点的 toast（侧栏红点由 Sidebar 另管）。
    const flushMissed = () => {
      if (!windowAttended()) return;
      const spec = missedRef.current.flush(useSessionStore.getState().currentSessionId);
      if (!spec) return;
      const c = copyRef.current;
      const notice = translateCronOsNotification(spec.latest, c, useAppStore.getState().language);
      const message = spec.count > 1
        ? c.missedAlertsMerged.replace('{count}', String(spec.count))
        : `${notice.title}: ${notice.body}`;
      const action = { label: c.failureToastView, onClick: () => openForEvent(spec.latest) };
      if (spec.type === 'error') toast.error(message, action, MISSED_ALERT_TOAST_MS);
      else toast.warning(message, action, MISSED_ALERT_TOAST_MS);
    };
    window.addEventListener('focus', flushMissed);
    document.addEventListener('visibilitychange', flushMissed);
    let disposed = false;
    let unregister: (() => Promise<void>) | undefined;
    void registerNotificationClick(openFromNotification).then((cleanup) => {
      if (disposed) {
        void cleanup?.();
      } else {
        unregister = cleanup;
      }
    });
    return () => {
      disposed = true;
      window.removeEventListener('focus', flushMissed);
      document.removeEventListener('visibilitychange', flushMissed);
      unsubscribe?.();
      void unregister?.();
    };
  }, []);
}
