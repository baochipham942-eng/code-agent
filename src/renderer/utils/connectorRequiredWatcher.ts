// ============================================================================
// connectorRequiredWatcher —— 连接卡 pending 时盯连接状态，连上后追加一条续跑消息
// ============================================================================
// 不挂在 ChatView 上：能力中心打开时 ChatView 会卸载（同时 sendPrompt 的 sender 也注销），
// 用户恰恰就是在那里登录的。所以由 App 级 hook 启动本控制器。
//
// 「已连接」判据与宿主 isConnectorReadyForTurnScope 一致：connected === true（原生连接器
// 若带 readiness 还须 ready）。stale 不算断开——MountedConnectorIcons 把 stale 当断开是
// 另一套展示口径，别在这里混用。
// 续跑只在「当前就是这个会话、没有在跑、聊天 sender 在」时发；否则保持 pending 继续等。
// ============================================================================

import { CONNECTOR_REQUIRED_POLL } from '@shared/constants';
import { IPC_CHANNELS, IPC_DOMAINS, type ConnectorEvent, type ConnectorStatusSummary } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { languages } from '../i18n';
import { interpolate } from '../i18n/interpolate';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useMessageActionStore } from '../stores/messageActionStore';
import { connectorRequiredKey, useConnectorRequiredStore, type ConnectorRequiredEntry } from '../stores/connectorRequiredStore';
import { connectorDisplayName } from './connectorDisplayName';

interface OAuthStatusItem { id: string; connected: boolean }

function parseOAuth(payload: unknown): OAuthStatusItem[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, connected } = item as Record<string, unknown>;
    return typeof id === 'string' && typeof connected === 'boolean' ? [{ id, connected }] : [];
  });
}

function connectedIds(native: ConnectorStatusSummary[], oauth: OAuthStatusItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of native) {
    if (item.connected === true && (!item.readiness || item.readiness === 'ready')) ids.add(item.id);
  }
  for (const item of oauth) {
    if (item.connected === true) ids.add(item.id);
  }
  return ids;
}

function pendingEntries(): ConnectorRequiredEntry[] {
  // insufficient_scope 的连接器本来就是「已连接」，按连接态自动续跑会让卡片瞬间消失——由卡片自己的重新授权驱动，不进 watcher
  return Object.values(useConnectorRequiredStore.getState().entries)
    .filter((entry) => entry.status === 'pending' && entry.reason !== 'insufficient_scope');
}

/** 追加续跑消息。条件不满足返回 false（保持 pending）；抢到 resuming 才发，保证只发一次。 */
export function resumeConnectorTask(entry: ConnectorRequiredEntry, nativeStatuses: ConnectorStatusSummary[] = []): boolean {
  const session = useSessionStore.getState();
  if (session.currentSessionId !== entry.sessionId) return false;
  if (session.isSessionRunning(entry.sessionId)) return false;
  const messageActions = useMessageActionStore.getState();
  if (!messageActions._send) return false;
  if (!useConnectorRequiredStore.getState().claimResume(entry.sessionId, entry.connectorId)) return false;
  const t = languages[useAppStore.getState().language];
  const text = interpolate(t.connectorRequired.continuation, { name: connectorDisplayName(entry.connectorId, nativeStatuses) });
  void messageActions.sendPrompt(text);
  return true;
}

export function startConnectorRequiredWatcher(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastNative: ConnectorStatusSummary[] = [];
  let lastOAuth: OAuthStatusItem[] = [];
  let inFlight = false;
  // 刚确认已连接、但还不能发续跑消息的卡（换了会话 / 正在跑 / sender 未注册）。
  // 只由新鲜数据（轮询结果、原生推送）重算，避免拿陈旧缓存给后来重新掉线的卡误发。
  let waiting = new Set<string>();

  const evaluate = (countPoll: boolean) => {
    const connected = connectedIds(lastNative, lastOAuth);
    waiting = new Set();
    for (const entry of pendingEntries()) {
      if (connected.has(entry.connectorId)) {
        if (!resumeConnectorTask(entry, lastNative)) waiting.add(connectorRequiredKey(entry.sessionId, entry.connectorId));
      } else if (countPoll) {
        useConnectorRequiredStore.getState().recordPoll(entry.sessionId, entry.connectorId, CONNECTOR_REQUIRED_POLL.MAX_POLLS);
      }
    }
  };

  const retryWaiting = () => {
    if (waiting.size === 0) return;
    const entries = useConnectorRequiredStore.getState().entries;
    for (const key of waiting) {
      const entry = entries[key];
      if (entry?.status === 'pending' && resumeConnectorTask(entry, lastNative)) waiting.delete(key);
    }
  };

  const hasPollable = () => pendingEntries().some((entry) => !entry.gaveUp);

  const tick = async () => {
    timer = null;
    if (stopped || inFlight || !hasPollable()) return;
    inFlight = true;
    try {
      const [native, oauth] = await Promise.all([
        ipcService.invokeDomain<ConnectorStatusSummary[]>(IPC_DOMAINS.CONNECTOR, 'listStatuses').catch(() => null),
        ipcService.invokeDomain<unknown>(IPC_DOMAINS.CONNECTOR, 'oauthStatus').catch(() => null),
      ]);
      if (native) lastNative = Array.isArray(native) ? native : [];
      if (oauth) lastOAuth = parseOAuth(oauth);
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    evaluate(true);
    schedule();
  };

  const schedule = () => {
    if (stopped || timer || !hasPollable()) return;
    timer = setTimeout(() => { void tick(); }, CONNECTOR_REQUIRED_POLL.INTERVAL_MS);
  };

  const unsubscribeNative = ipcService.on(IPC_CHANNELS.CONNECTOR_EVENT, (event: ConnectorEvent) => {
    lastNative = Array.isArray(event?.data) ? event.data : [];
    evaluate(false);
  });

  // 新卡出现 / 会话切换 / 会话跑完 / 聊天 sender 重新注册（能力中心关掉回到聊天）都重估一次
  const unsubscribeStores = [
    useConnectorRequiredStore.subscribe(() => { schedule(); }),
    useSessionStore.subscribe(retryWaiting),
    useMessageActionStore.subscribe(retryWaiting),
  ];
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribeNative?.();
    unsubscribeStores.forEach((unsubscribe) => unsubscribe());
  };
}
