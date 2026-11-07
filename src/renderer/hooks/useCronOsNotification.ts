import { useEffect, useRef } from 'react';
import { IPC_CHANNELS, type NotificationShowEvent } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { isSecondaryPageActive } from '../utils/secondaryPageActive';
import { useWorkbenchFocusStore } from '../stores/workbenchFocusStore';
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
import { postOsNotification, registerNotificationClick, reportNotificationHandled } from '../utils/osNotification';
import { sessionAutomationClient } from '../services/sessionAutomationClient';
import { listenTauriEvent } from '../services/tauriPluginFacade';
import { isTauriMode } from '../utils/platform';

const MISSED_ALERT_TOAST_MS = 10_000;
const RECENT_EVENT_LIMIT = 50;

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
  const recentEventsRef = useRef(new Map<string, NotificationShowEvent>());
  const handledClicksRef = useRef(new Set<string>());

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
    // 点击路由：接收端契约是壳发 `notification-clicked {id}`（id = NotificationShowEvent.id）。
    // 注意：当前壳尚未发该事件（发射端由 N-FIX-NOTIFY-DISPLAY-GAP-FU1-NATIVE 负责），
    // 在那之前桌面端只走下面的旧 onAction 路径（读最近一条事件，桌面端通常根本不触发）。
    // 按通知类型落点，且每个 id 只处理一次。会话/jobId/登录墙落点全在 openForEvent
    // （含「无会话仅 jobId → Center」）；这里只补本单独有的一步：needs-input 且有待审批
    // 卡时落自动化中心「运行」收件箱，而不是会话。
    const routeClick = async (event: NotificationShowEvent) => {
      const needsInput = event.urgent === true && event.failure !== true;
      if (needsInput && event.sessionId) {
        // 待审批卡只在自动化中心「运行」收件箱里，会话内没有；有 pending 项就落收件箱。
        let parked = false;
        try {
          const items = await sessionAutomationClient.listParkedApprovals();
          parked = (items ?? []).some((i) => i.sessionId === event.sessionId && i.status === 'pending');
        } catch (err) {
          console.warn('[useCronOsNotification] listParkedApprovals failed, falling back to session', err);
        }
        if (parked) useAppStore.getState().openCronCenterRuns();
        else onOpenSessionRef.current(event.sessionId);
        return;
      }
      openForEvent(event);
    };
    const claimClick = (id: string): boolean => {
      const handled = handledClicksRef.current;
      if (handled.has(id)) return false;
      handled.add(id);
      if (handled.size > RECENT_EVENT_LIMIT * 2) handled.delete(handled.values().next().value as string);
      return true;
    };
    const clickById = (id: string) => {
      const event = recentEventsRef.current.get(id);
      if (!event) {
        console.warn('[useCronOsNotification] notification-clicked: unknown notification id', id);
        return;
      }
      if (!claimClick(id)) return;
      void routeClick(event);
    };
    // 旧 onAction 路径：优先用最近事件的 id 过同一道去重，没有就退回最近事件。
    const openFromNotification = () => {
      const last = lastEventRef.current;
      if (last && !claimClick(last.id)) return;
      void (last ? routeClick(last) : Promise.resolve(openForEvent(null)));
    };
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.NOTIFICATION_SHOW,
      (event: NotificationShowEvent) => {
        // 审批已裁决的撤回：只把「离开期间的提醒」队列里那条 needs-input 移掉，
        // 不弹 OS 通知、不作点击目标（retract 本身没有任何用户可见动作）。
        if (event.retract) {
          missedRef.current.remove(event.dedupeKey);
          reportNotificationHandled({ mode: 'renderer-early-return', reason: 'retract', dispatched: false, dedupeKey: event.dedupeKey });
          return;
        }
        // 预算窗口折起弹窗时单独送达的未读标记：只供侧栏圆点，不弹 OS 通知、不作点击目标。
        if (event.attentionOnly) {
          reportNotificationHandled({ mode: 'renderer-early-return', reason: 'attention-only', dispatched: false });
          return;
        }
        lastEventRef.current = event;
        const recent = recentEventsRef.current;
        recent.delete(event.id);
        recent.set(event.id, event);
        if (recent.size > RECENT_EVENT_LIMIT) recent.delete(recent.keys().next().value as string);
        missedRef.current.record(event, windowAttended());
        const needsInput = event.urgent === true && event.failure !== true;
        const viewingSession = needsInput
          && !!event.sessionId
          && !isSecondaryPageActive(useAppStore.getState())
          // 专注模式收起聊天列，审批卡不在屏幕上（App.tsx 只在 !workbenchFocusActive
          // 时渲染聊天列，且右栏不可见时 store 会被复位）——不能算「正看着该会话」。
          && !useWorkbenchFocusStore.getState().workbenchFocused
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
    let unlistenClick: (() => void) | undefined;
    if (isTauriMode()) {
      void listenTauriEvent<{ id: string }>('notification-clicked', (e) => {
        const id = e?.payload?.id;
        if (typeof id === 'string') clickById(id);
      }).then((fn) => {
        if (disposed) fn();
        else unlistenClick = fn;
      }).catch((err) => {
        console.warn('[useCronOsNotification] notification-clicked listen failed', err);
      });
    }
    return () => {
      disposed = true;
      unlistenClick?.();
      window.removeEventListener('focus', flushMissed);
      document.removeEventListener('visibilitychange', flushMissed);
      unsubscribe?.();
      void unregister?.();
    };
  }, []);
}
