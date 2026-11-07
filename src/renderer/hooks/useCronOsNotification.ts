import { useEffect, useRef } from 'react';
import { IPC_CHANNELS, type NotificationShowEvent } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { isSecondaryPageActive } from '../utils/secondaryPageActive';
import { useCronStore } from '../stores/cronStore';
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
      // 无会话失败没有本地会话可跳：点击落 Cron Center 并选中该任务，详情里就是
      // 这句人话和「立即重跑/重新启用」——不然这次点击只是把 app 带到前台。
      // 两类：云端调度器不可用（报文分类 cloud_unavailable）与最终停用（jobId、无 code，
      // 停用执行可能根本没有 session，如云端 run）；登录墙走上面的同意路径，不落这里。
      const cronCenterJobId = sessionId || siteOrigin
        ? undefined
        : cronFailureCloudDownJobId(event) ?? event?.jobId;
      if (cronCenterJobId) {
        useCronStore.getState().selectJob(cronCenterJobId);
        useAppStore.getState().setShowCronCenter(true);
      }
    };
    const openFromNotification = () => openForEvent(lastEventRef.current);
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      (event: NotificationShowEvent) => {
        // 审批已裁决的撤回：只把「离开期间的提醒」队列里那条 needs-input 移掉，
        // 不弹 OS 通知、不作点击目标（retract 本身没有任何用户可见动作）。
        if (event.retract) {
          missedRef.current.remove(event.dedupeKey);
          return;
        }
        // 预算窗口折起弹窗时单独送达的未读标记：只供侧栏圆点，不弹 OS 通知、不作点击目标。
        if (event.attentionOnly) return;
        lastEventRef.current = event;
        missedRef.current.record(event, windowAttended());
        const needsInput = event.urgent === true && event.failure !== true;
        const viewingSession = needsInput
          && !!event.sessionId
          && !isSecondaryPageActive(useAppStore.getState())
          && useSessionStore.getState().currentSessionId === event.sessionId;
        void postOsNotification(translateCronOsNotification(
          event,
          copyRef.current,
          useAppStore.getState().language,
        ), {
          urgent: event.urgent === true,
          failure: event.failure === true,
          viewingSession,
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
