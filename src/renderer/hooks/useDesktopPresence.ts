// ============================================================================
// useDesktopPresence — 桌面在场心跳（N-NOTIFY-PRESENCE-HEARTBEAT）
// ============================================================================
//
// 每 COMPANION_LIMITS.desktopPresenceHeartbeatMs 向 notification 域 reportPresence 上报
// {窗口可见, 聚焦, 最近输入, 正在看的会话}；可见性/焦点切换时立即加报一拍。host 侧
// CompanionPushOutbox 用它压掉普通完成推送（approval / error 紧急类不受影响）。
// 从 App 根组件挂载一次；所有失败吞掉——心跳是尽力而为，绝不打扰渲染路径。
// 不在范围（任务书钉死）：系统 idle/锁屏检测、手机→桌面已读、设置开关。

import { useEffect, useRef } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { COMPANION_LIMITS } from '@shared/constants/companion';
import type { NotificationPresenceReport } from '@shared/ipc/schemas/notification';
import ipcService from '../services/ipcService';
import { useSessionStore } from '../stores/sessionStore';

export function useDesktopPresence(): void {
  // 最近输入时间（epoch ms）：发送时读取，输入事件只按拍采样写 ref
  const lastInputAtRef = useRef<number>(Date.now());
  const lastSampleRef = useRef<number>(0);

  useEffect(() => {
    const send = (): void => {
      const report: NotificationPresenceReport = {
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        lastInputAt: lastInputAtRef.current,
        viewingSessionId: useSessionStore.getState().currentSessionId,
      };
      try {
        // 尽力而为：IPC 挂了/通道未就绪都不许冒泡到渲染路径
        void ipcService.invokeDomain(IPC_DOMAINS.NOTIFICATION, 'reportPresence', report).catch(() => {});
      } catch {
        /* ignore */
      }
    };

    const noteInput = (): void => {
      const at = Date.now();
      if (at - lastSampleRef.current < COMPANION_LIMITS.desktopPresenceInputSampleMs) return;
      lastSampleRef.current = at;
      lastInputAtRef.current = at;
    };

    // 挂载即报一拍，host 不用等第一个间隔才知道 renderer 活着
    send();
    const heartbeat = window.setInterval(send, COMPANION_LIMITS.desktopPresenceHeartbeatMs);
    // 可见性/焦点切换立即加报：这两项恰恰是切换那一刻最需要刷新的信号
    document.addEventListener('visibilitychange', send);
    window.addEventListener('focus', send);
    window.addEventListener('blur', send);
    // capture+passive：目标节点拦事件也不漏采样，且绝不阻塞输入路径
    window.addEventListener('pointerdown', noteInput, { capture: true, passive: true });
    window.addEventListener('pointermove', noteInput, { capture: true, passive: true });
    window.addEventListener('keydown', noteInput, { capture: true, passive: true });

    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', send);
      window.removeEventListener('focus', send);
      window.removeEventListener('blur', send);
      window.removeEventListener('pointerdown', noteInput, { capture: true });
      window.removeEventListener('pointermove', noteInput, { capture: true });
      window.removeEventListener('keydown', noteInput, { capture: true });
    };
  }, []);
}
