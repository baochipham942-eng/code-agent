import { Composer } from '../features/sessions/Composer';
import { AttachmentSheet } from '../features/sessions/AttachmentSheet';
import { LibrarySheet } from '../features/sessions/LibrarySheet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { PlatformPorts } from '../platform/ports';
import { createMobileStore } from '../stores/mobileStore';
import { canAddressSession, createCompanionStore, needsLibraryPick } from '../stores/companionStore';
import { createNotificationStore } from '../stores/notificationStore';
import { unavailableNotificationPort } from '../platform/notifications';
import { pickAttachment } from '../platform/cameraPick';
import { COMPANION_LIMITS } from '../../../../src/shared/constants/companion';
import { ApprovalCard } from '../features/sessions/ApprovalCard';
import { QuestionCard } from '../features/sessions/QuestionCard';
import { PlanCard } from '../features/sessions/PlanCard';
import { CompanionConversation } from '../features/sessions/CompanionConversation';
import type { CompanionLibrary } from '../../../../src/shared/contract/companionLibrary';
import { messages } from '../i18n';
import { defaultProjectId, projectDisplayName } from '../features/sessions/projectRows';
import { createBackCoordinator } from './backCoordinator';
import { PreviewMedia } from '../features/sessions/PreviewMedia';
import { applyKeyboardInset } from './keyboardInset';
import { SheetHost } from './SheetHost';
import { SettingsPage } from '../features/settings/SettingsPage';
import { PairConfirm } from '../features/settings/PairConfirm';
import { deriveInvitationVerify, parseInvitation, type LanInvitation } from '../../../../src/shared/companion/lanProtocol';
import { VirtualHistory } from '../features/sessions/VirtualHistory';
import { NeoBrandMark } from '../features/brand/NeoBrandMark';
import { AppIcon } from './AppIcon';
import { sheetLibraryStatus } from './sheetLibraryStatus';
import { commandNoticeCopy, composerStatusItems } from './StatusSlot';
import { connectionDiagnosis, lastSyncCopy } from './connectionDiagnosis';
import { CLICK_SWALLOW_MS, DRAWER_SETTLE_MS, EDGE_GESTURE_START_X, drawerPanOffset, drawerPanState, drawerWidthPx, gestureAxis, shouldSwallowClick } from './drawerGesture';

/**
 * 输入区模型胶囊的文案（design.html composer 的 .model）：显示这条会话下一次执行真正会用的模型
 * ——电脑侧按「会话 override 否则电脑默认」算好了发过来（build 45 真机：胶囊写 glm-5.3-flash，实跑默认模型）。
 * 模型表里查不到就退回会话自己的模型 id——电脑的可用模型列表会剔掉没配 key 的 provider，
 * 而会话可能正用着其中一个（2026-09-12 build 24 真机：会话是 custom-glm-coding/glm-5.3-flash，
 * 不在列表里）。查不到只说明「没有好看的名字」，不说明「没有模型」，隐藏胶囊等于把事实藏了；
 * 同理也不拿列表第一个冒充当前模型（那正是 FB-141 那类谎）。
 */
export function composerModelLabel(library: CompanionLibrary | null, sessionId: string | null): string | null {
  const session = library?.sessions.find(item => item.id === sessionId);
  if (!session || !library) return null;
  return library.models.find(m => m.provider === session.provider && m.model === session.model)?.label ?? session.model;
}

/** 电脑名：mDNS 名去掉 .local；没有 mDNS 名（Linux/Windows 宿主）时给 null，调用方退回 IP。 */
function invitationHostLabel(invitation: { endpoint: string; altEndpoint?: string }): string | null {
  try {
    const host = new URL(invitation.altEndpoint ?? invitation.endpoint).hostname;
    return host.endsWith('.local') ? host.slice(0, -'.local'.length) : null;
  } catch { return null; }
}

/**
 * 抽屉手势（fix4-①，2026-09-14 build 35 反馈⑥）：touchmove 阶段 1:1 跟手、松手按
 * 速度+过半双判据落态。判定逻辑抽在 drawerGesture.ts（纯函数，可单测）；这里的
 * swipe ref 只记起手与上一帧位置（算松手速度），pan state 驱动跟手 transform。
 */
type DrawerPan = { dx: number; settle: 'open' | 'close' | null };

export function MobileRoot({ ports, fixtures }: { ports: PlatformPorts; fixtures: boolean }) {
  const [store] = useState(() => createMobileStore(ports.preferences));
  const [companionStore] = useState(() => createCompanionStore(ports.companion, (acceptedText, sessionId, hostKey) => {
    return store.getState().acknowledgeDraft(acceptedText, `${hostKey}:${sessionId}`);
  }, (text, sessionId, hostKey, commandId, continuation) => store.getState().appendTranscript(text, `${hostKey}:${sessionId}`, commandId, continuation), ports.files, ports.historyCache, {
    lastSession: hostKey => store.getState().preferences.lastSessions?.[hostKey],
    rememberSession: (hostKey, sessionId) => store.getState().rememberSession(hostKey, sessionId),
    forgetSessionTitles: (hostKey, sessionId) => store.getState().forgetSessionTitles(hostKey, sessionId),
  }));
  const appActive = useRef(true);
  const [notifyStore] = useState(() => createNotificationStore({
    port: ports.notifications ?? unavailableNotificationPort,
    preference: {
      get: () => store.getState().preferences.notifyEnabled,
      set: value => store.getState().setNotifyEnabled(value),
    },
    session: {
      status: () => companionStore.getState().status,
      register: input => companionStore.getState().registerPush(input),
      unregister: () => companionStore.getState().unregisterPush(),
      openRoute: token => companionStore.getState().openRoute(token),
      reconnect: () => companionStore.getState().reconnect(),
      // 「正在看」= 前台、会话页没被抽屉/弹层盖着、连着电脑（离线时会话里不会就地出新状态，照常弹）。
      viewing: () => {
        const ui = store.getState();
        const live = companionStore.getState();
        return appActive.current && !ui.drawer && !ui.sheet && ui.route !== 'fixture' && live.status === 'connected' ? live.sessionId : null;
      },
      resolveRoute: token => companionStore.getState().resolveRoute(token),
    },
  }));
  const companion = useStore(companionStore);
  const notify = useStore(notifyStore);
  const state = useStore(store);
  const text = messages(navigator.language);
  const [appInfo, setAppInfo] = useState<{ version: string; build: string } | null>(null);
  const [nativeError, setNativeError] = useState(false);
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const [cacheResult, setCacheResult] = useState<'clean' | null>(null);
  // Native pushes the Android night flag (WebView 95 never updates prefers-color-scheme); matchMedia covers web/iOS.
  const [systemDark, setSystemDark] = useState(() => document.documentElement.dataset.systemNight === 'true'
    || matchMedia('(prefers-color-scheme: dark)').matches);
  const keyboardVisible = useRef(false);
  const composerNode = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useRef(0);
  const viewportFrozen = useRef<number | null>(null);
  const managing = useRef(false);
  const swipe = useRef<{ x: number; y: number; lastX: number; lastT: number; axis: 'horizontal' | 'vertical' | null } | null>(null);
  /** 拖拽中的抽屉：dx 为位移、settle 非空表示松手后正带 transition 回弹到目标态。 */
  const [pan, setPan] = useState<DrawerPan | null>(null);
  const settleTimer = useRef(0);
  // 锁轴拖拽后的 click 吞掉窗口（fix5-②）：拖一半松手时合成的 click 落在起手的会话行上，
  // 会变成「点中会话」。吞一次即复位——窗口内若没有 click 跟来（拖到 scrim 上松手），
  // 到点由定时器自清，下一次真实点按不受影响。
  const swallowClick = useRef(false);
  const swallowTimer = useRef(0);
  useEffect(() => () => { clearTimeout(settleTimer.current); clearTimeout(swallowTimer.current); }, []);
  const recording = useRef(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const composerObserver = useRef<ResizeObserver | null>(null);
  /**
   * 输入区是**浮在**会话上的一层，不是挤它的兄弟（爸 2026-09-13：删字时上方 trace 抖动，
   * 「输入框内的内容不应该影响到上方 trace，应该是前后两层」）。
   *
   * 会话区的可视高度必须与输入区高度无关：它们同在一条 flex 流里时，输入区一变高矮就改
   * `.lan-messages` 的 clientHeight，浏览器保留（贴底时 clamp）scrollTop ⇒ 内容位移，
   * 而 CompanionConversation 的「跟到底」只在消息变化时跑、不管缩放，位移之后没人纠正。
   * 会改高矮的不止 textarea 自适应：审批卡弹出、状态行换行都在这一块里，所以观察整块，
   * 把实测高度发布成 --composer-h，由滚动容器拿去做**底部内边距**——
   * 只改 scrollHeight、不改 clientHeight，不贴底时可视内容一动不动。
   */
  // 用**回调 ref** 而不是 useEffect：MobileRoot 首帧是 loading（`!state.ready` 时整棵会话树
  // 都不在 DOM 里），依赖写 [] 的 effect 就在那一帧跑掉、refs 全空、之后永不重跑，
  // --composer-h 永远停在 132px 兜底——而**每一次真实启动都会经过那一帧**
  // （grok ai-review Important）。回调 ref 在节点真正挂上时才跑，没有这个时序坑。
  const composerArea = useCallback((node: HTMLDivElement | null) => {
    composerObserver.current?.disconnect();
    composerObserver.current = null;
    composerNode.current = node;
    // loading → ready 时节点才挂上；若 willShow 已经到了，补一次，别等下一次键盘事件。
    if (node && keyboardInset.current > 0) applyKeyboardInset(node, 0, keyboardInset.current);
    // 往上找会话根而不是另拿一个 ref：ref 回调是自下而上触发的，父节点的 ref 这时可能还没挂上。
    const root = node?.closest<HTMLElement>('.conversation');
    if (!node || !root) return;
    const sync = () => {
      const height = node.offsetHeight;
      root.style.setProperty('--composer-h', `${height}px`);
      // 贴底的人要跟着这层一起走：padding 变高会把最后一条顶到这层后面去，
      // 而「跟到底」原本只在消息变化时跑（验收②）。
      setComposerHeight(height);
    };
    // 先量一次再谈观察：没有 ResizeObserver 的宿主（老安卓 WebView）如果连这一次都不写，
    // 首屏就是错的。量一次至少让首屏对，之后不跟着变是这类宿主的已知上限。
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    composerObserver.current = new ResizeObserver(sync);
    composerObserver.current.observe(node);
  }, []);
  const [voiceFailureShown, setVoiceFailureShown] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<{ raw: string; invitation: LanInvitation } | null>(null);
  // 项目会话前进页（fix5-③）当前在看的项目：主层选择器的 chevron 进来，返回弹回主层。
  const [sessionProjectId, setSessionProjectId] = useState<string | null>(null);
  const theme = state.preferences.appearance === 'system' ? (systemDark ? 'dark' : 'light') : state.preferences.appearance;
  const currentPage = state.sheet?.pages.at(-1);
  const pendingDecisions = useMemo(() => {
    const cards = new Map<string, Record<string, unknown>>();
    for (const event of companion.events) {
      if ((event.kind === 'approval' || event.kind === 'question' || event.kind === 'plan') && typeof event.payload.requestId === 'string') {
        cards.set(`${event.kind}:${event.payload.requestId}`, { ...cards.get(`${event.kind}:${event.payload.requestId}`), ...event.payload, sessionId: event.sessionId, kind: event.kind });
      }
    }
    return [...cards.values()].filter(card => card.status === 'pending');
  }, [companion.events, companion.sessionId]);
  const otherDecision = pendingDecisions.find(card => card.sessionId !== companion.sessionId);
  const trayCard = pendingDecisions.find(card => card.sessionId === companion.sessionId && card.kind === 'approval')
    ?? pendingDecisions.find(card => card.sessionId === companion.sessionId && card.kind === 'question')
    ?? pendingDecisions.find(card => card.sessionId === companion.sessionId && card.kind === 'plan');
  // 输入区的模型胶囊（design.html composer 的 .model）：显示这条会话当前在用的模型，
  // 没有会话或还没读到模型表时不显示——不拿列表第一个冒充当前模型。
  const sessionModelLabel = composerModelLabel(companion.library, companion.sessionId);
  // 反馈③（2026-09-14 build 34）：项目/会话 sheet 等电脑里的库时不许无限转圈——底层 request
  // 没有客户端超时，连接僵死时圈会一直转；到点落「连不上电脑」失败态并给重试。
  const librarySheetWaiting = Boolean(state.sheet && (currentPage === 'projects' || currentPage === 'projectSessions' || currentPage === 'more' || currentPage === 'model') && companion.binding && !companion.library);
  const [libraryTimedOut, setLibraryTimedOut] = useState(false);
  const [libraryRetryEpoch, setLibraryRetryEpoch] = useState(0);
  useEffect(() => {
    // 每当等待重新成立（新开 sheet 或点了重试）计时从零开始；不在等时清掉标记。
    setLibraryTimedOut(false);
    if (!librarySheetWaiting) return;
    const timer = setTimeout(() => setLibraryTimedOut(true), COMPANION_LIMITS.librarySheetWaitMs);
    return () => clearTimeout(timer);
  }, [librarySheetWaiting, libraryRetryEpoch]);
  const retrySheetLibrary = () => {
    setLibraryRetryEpoch(epoch => epoch + 1);   // 计时归零，重新给一轮秒级等待
    const live = companionStore.getState();
    // 断连时 refreshLibrary 是空转（非 connected 直接 return），重连才是真动作；
    // 连上后既有 effect 会去读库。
    if (live.status !== 'connected') void live.reconnect();
    else void live.refreshLibrary();
  };

  // Text selections inside the composer never surface through window.getSelection on WebKit,
  // and long-press selection on WebView only lives in the element's own range.
  const selectedInput = () => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active : null;
  };
  const textSelected = () => {
    if (window.getSelection()?.toString()) return true;
    const input = selectedInput();
    return !!input && input.selectionStart !== input.selectionEnd;
  };
  const clearTextSelection = () => {
    if (window.getSelection()?.toString()) { window.getSelection()?.removeAllRanges(); return; }
    const input = selectedInput();
    if (input) input.setSelectionRange(input.selectionEnd, input.selectionEnd);
  };
  useEffect(() => {
    void store.getState().hydrate();
    void ports.appInfo.read().then(setAppInfo).catch(() => setAppInfo(null));
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const register = (promise: Promise<() => void>) => void promise.then(cleanup => {
      if (disposed) cleanup(); else cleanups.push(cleanup);
    }).catch(() => { if (!disposed) setNativeError(true); });
    const back = createBackCoordinator({
      ports,
      hasSelection: textSelected,
      clearSelection: clearTextSelection,
      isKeyboardVisible: () => keyboardVisible.current,
      dismissLayer: () => store.getState().back(),
      onNativeError: () => setNativeError(true),
    });
    register(ports.lifecycle.subscribe(active => {
      appActive.current = active;
      if (!active) { void store.getState().flush(); companionStore.getState().pause(); }
      else {
        if (companionStore.getState().binding) void companionStore.getState().reconnect();
        void notifyStore.getState().recover();
      }
    }, back.onBack));
    register((ports.notifications ?? unavailableNotificationPort).tap.subscribe(token => {
      void notifyStore.getState().handleTap(token);
    }));
    // 前台正看着同一条会话时不弹系统推送（N-MOBILE-EXEC-STATUS ④）：会话里已经就地显示了，横幅是重复打扰。
    const foreground = (ports.notifications ?? unavailableNotificationPort).foreground;
    if (foreground) register(foreground.subscribe(routeToken => notifyStore.getState().decideForeground(routeToken)));
    let frame = 0;
    const applyViewportHeight = () => {
      frame = 0;
      // iOS 键盘期间冻结为 innerHeight：visualViewport 会跟着键盘缩，再写进 --viewport-height
      // 就是整页布局追合成器。Android 不订 subscribeFrame，冻结保持 null，继续跟 visualViewport。
      const height = viewportFrozen.current ?? window.visualViewport?.height ?? innerHeight;
      document.documentElement.style.setProperty('--viewport-height', `${height}px`);
    };
    const resize = () => { if (!frame) frame = requestAnimationFrame(applyViewportHeight); };
    applyViewportHeight();   // 首帧直接落地，别等下一帧才有高度
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
    register(ports.keyboard.subscribe(visible => {
      keyboardVisible.current = visible;
      // DidHide 才解冻：WillHide 时输入区还在往下落，不能让 .app 高度同时追 visualViewport。
      if (!visible) { viewportFrozen.current = null; applyViewportHeight(); }
    }));
    register(ports.keyboard.subscribeFrame(next => {
      const from = keyboardInset.current;
      const to = Math.max(0, Math.round(next.height));
      if (next.phase === 'will-show') {
        viewportFrozen.current = window.innerHeight;
        applyViewportHeight();
      }
      keyboardInset.current = to;
      const node = composerNode.current;
      if (node) applyKeyboardInset(node, from, to);
    }));
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); back.onBack(); } };
    document.addEventListener('keydown', escape);
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(document.documentElement.dataset.systemNight === 'true' || query.matches);
    document.addEventListener('neo-system-night', change);
    query.addEventListener('change', change);
    return () => {
      companionStore.getState().pause();
      disposed = true; cleanups.forEach(cleanup => cleanup());
      document.removeEventListener('keydown', escape); document.removeEventListener('neo-system-night', change); query.removeEventListener('change', change);
      window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ports, store, companionStore, notifyStore]);
  useEffect(() => { if (state.ready) void companionStore.getState().hydrate(); }, [state.ready, companionStore]);
  /**
   * 待确认命令「慢到该说话了」的闸门（N-MOBILE-PENDING-NOISE）。pending 一起就开计时，
   * 结算就复位；到点之前状态位不说「还没收到电脑确认」。放在 MobileRoot 而不是 store：这是纯粹的
   * 呈现节奏，store 那边的 pending 仍然是「有没有待确认命令」这个事实，不掺 UI 时序。
   */
  const [pendingSlow, setPendingSlow] = useState(false);
  /**
   * 录音面板是否正占着输入区。它顶掉整块 composer ⇒ 停止那个键此刻不存在，得把停止
   * 临时交回执行条（grok ai-review PR#1903 Nit①）。用 state 而不是那个 recording ref：
   * ref 变了不重渲染，执行条不会知道该长出按钮来。
   */
  const [voiceActive, setVoiceActive] = useState(false);
  /**
   * hydrate 从盘上带回来的待确认命令已经等了不知道多久（可能是上次开着 app 时留下的），
   * 再从 0 憋 3 秒等于把已知的「它很慢」这个事实丢掉（grok ai-review PR#1903 Nit②）。
   * 「是不是捡回来的」由 store 的 pendingAdopted 给，不在这里靠时序推断——
   * 初版我用「第一次见到 pending 就为真」判断，而 store 初始 pending 恒为 false，
   * 那个判据永远不成立，改了等于没改（实测抓到）。
   */
  useEffect(() => {
    if (!companion.pending) { setPendingSlow(false); return; }
    // 盘上捡回来的旧槽已经等了不知道多久，立刻说；本次会话亲手发的才计时。
    if (companion.pendingAdopted) { setPendingSlow(true); return; }
    const timer = setTimeout(() => setPendingSlow(true), COMPANION_LIMITS.pendingNoticeDelayMs);
    return () => clearTimeout(timer);
  }, [companion.pending, companion.pendingAction, companion.pendingAdopted]);
  useEffect(() => {
    if (companion.status !== 'connected') return;
    void notifyStore.getState().recover();
    void companionStore.getState().refreshLibrary();
    void companionStore.getState().sync();
  }, [companion.status, companionStore, notifyStore]);
  useEffect(() => {
    if (companion.status !== 'connected') return;
    // 待确认命令的结算只能靠轮询取回，所以转写在飞时把节奏加密：1 秒一拍意味着每段转写平均
    // 白等半秒（2026-09-12 真机：14 段云端往返均值只有 905ms，轮询这半秒是「识别有点久」
    // 四个来源里最便宜的一个）。只对 voice.transcribe 加密：它秒级就结算，别的命令（跑任务、
    // 传文件）可能挂很久，全局加密等于长时间空转电台。
    const timer = setInterval(() => { void companionStore.getState().sync(); },
      companion.pendingAction === 'voice.transcribe' ? COMPANION_LIMITS.pendingPollIntervalMs : COMPANION_LIMITS.pollIntervalMs);
    return () => clearInterval(timer);
  }, [companion.status, companion.pendingAction, companionStore]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // #1737 起 systemBars 是可选口（并非所有宿主都提供系统栏控制），必须可选链。
    void ports.systemBars?.setStyle(theme).catch(() => {});
  }, [ports, theme]);

  useEffect(() => {
    if (companion.sessionId && companion.binding && state.route !== 'fixture') {
      store.getState().activateDraft(`${companion.binding.hostKey}:${companion.sessionId}`);
      void companionStore.getState().loadHistory(companion.sessionId);
      void companionStore.getState().refreshArtifacts();
    } else if (state.route !== 'fixture') store.getState().activateDraft('new');
  }, [companion.sessionId, companion.binding?.hostKey, companion.status, state.route, store, companionStore]);
  // lastSessions 双写入口的渲染侧那处（ai-review Nit，刻意保留）：store 内 rememberSession
  // 管 companionStore 内部时点（配对/撤销/会话消失）；这里管「会话或绑定变化、偏好盘就绪后
  // 跟随渲染同步一次」。
  useEffect(() => {
    const hostKey = companion.binding?.hostKey;
    if (!hostKey || !state.ready) return;
    store.getState().rememberSession(hostKey, companion.sessionId);
  }, [companion.sessionId, companion.binding?.hostKey, state.ready, store]);
  // 当前会话的标题随库一起记（O1）：冷启动宿主停机时 library 还没到，缓存会话的标题从这里取，
  // 不再坠到「共享会话 N」这种谁也认不出的占位。
  useEffect(() => {
    const hostKey = companion.binding?.hostKey;
    if (!hostKey || !companion.sessionId || !companion.library) return;
    const title = companion.library.sessions.find(s => s.id === companion.sessionId)?.title;
    if (title) store.getState().rememberSessionTitle(hostKey, companion.sessionId, title);
  }, [companion.sessionId, companion.binding?.hostKey, companion.library, store]);
  // 连上而没有会话时不再自动弹「选择项目」（N-MOBILE-DEFAULT-PROJECT ②A，爸 09-17「项目要有默认、不强制选」）：
  // 停在新会话欢迎页，项目选择器已带默认项目；弹层只在点选择器、或都建不了时点发送才开。
  /**
   * 没选会话点发送（N-MOBILE-DEFAULT-PROJECT）：先在所选项目建会话，ack 回来、sessionId 生效后再把草稿发出。
   * 命令槽同一时刻只容一条在飞，create 可能还在 reconciling，所以等这里看到槽空了、新会话到了才 send。
   * 放在 activateDraft 那个 effect 之后：它先把 'new' 草稿搬进新会话的键，这里读到的才是那份草稿。
   */
  const firstSend = useRef<{ before: string | null } | null>(null);
  useEffect(() => {
    const waiting = firstSend.current;
    if (!waiting) return;
    // 断连或建会话失败：不留「连上后自动发出」的尾巴（design：草稿不在恢复连接后自动发出），草稿原样留着。
    if (companion.status !== 'connected' || (companion.commandError && companion.commandErrorAction === 'session.create')) { firstSend.current = null; return; }
    if (companion.pending || companion.busy || !companion.sessionId || companion.sessionId === waiting.before) return;
    firstSend.current = null;
    const ui = store.getState();
    const draft = ui.preferences.drafts[ui.draftKey] ?? '';
    if (draft.trim()) void companionStore.getState().send(draft);
  }, [companion.status, companion.commandError, companion.commandErrorAction, companion.pending, companion.busy, companion.sessionId, store, companionStore]);
  useEffect(() => { if (currentPage !== 'storage') { setCacheConfirm(false); setCacheResult(null); } }, [currentPage]);
  const commandNotice = commandNoticeCopy(text, companion, voiceFailureShown);
  // 选中即收边栏（fix5-①，2026-09-15 build 36 反馈⑦）：抽屉会话行、别会话待确认跳转、sheet 里的
  // 待确认跳转三处都走这里。navigate 虽也带 drawer:false，收边栏是选会话的第一意图，
  // 显式先关——不把它押在路由切换的副作用上。
  const selectSession = (id: string) => { companion.selectSession(id); state.closeDrawer(); state.navigate('new'); };
  // 主层选择器 → 项目会话前进页（同弹层 push，返回弹回主层，不堆在主层里）。
  const openProjectSessions = (id: string) => { setSessionProjectId(id); state.pushSheet('projectSessions'); };
  /**
   * 打开选择会话模型时现拉一次库：「最近调用失败」是电脑在执行失败那一刻才标上的，而手机手里的库是
   * 连上或会话操作时拉的旧副本——恰好在用户点「换一个可用模型」的那一刻看不到标记（build 46 远端验收实测）。
   */
  const openModelSheet = () => { state.openSheet('model'); void companion.refreshModels(); };
  // 项目会话前进页的标题 = 主层那一行的显示名（同名项目带路径消歧），点进行页标题就是刚才点的那行。
  const sessionProject = companion.library?.projects.find(p => p.id === sessionProjectId) ?? null;
  // 新任务的项目与模型（N-MOBILE-DEFAULT-PROJECT）：手选过的 > 最近用过的 > 未分类；模型 = 电脑默认 > 列表第一项（FB-141）。
  const hostKey = companion.binding?.hostKey;
  const newTaskProjectId = companion.library ? defaultProjectId(companion.library, hostKey ? state.preferences.projectPicks?.[hostKey] : undefined) : null;
  const newTaskModel = companion.library?.models.find(m => m.isDefault) ?? companion.library?.models[0];
  /** 「会话没建成」那条状态的重试：重做最近一次建会话的那个动作（+、没选会话发送、弹层里选项目）。 */
  const lastCreate = useRef<(() => void) | null>(null);
  const createInDefaultProject = () => {
    if (!newTaskProjectId || !newTaskModel) { state.openSheet('projects'); return false; }
    void manage('session.create', { title: text.newSession, provider: newTaskModel.provider, model: newTaskModel.model }, `project:${newTaskProjectId}`).then(() => {
      const live = companionStore.getState();
      if (live.commandError && live.commandErrorAction === 'session.create') firstSend.current = null;
    });
    return true;
  };
  const startDefaultSession = () => { lastCreate.current = startDefaultSession; createInDefaultProject(); };
  const sendAsNewSession = () => {
    lastCreate.current = sendAsNewSession;
    firstSend.current = { before: companion.sessionId };
    if (!createInDefaultProject()) firstSend.current = null;
  };
  /** 弹层里点项目 / 在项目里新建 = 手选，按这台电脑记住，之后的新任务默认落在这里。 */
  const sheetManage: typeof companion.manage = (...args) => {
    if (args[0] === 'session.create') {
      lastCreate.current = () => void sheetManage(...args);
      if (hostKey && args[2]?.startsWith('project:')) state.pickProject(hostKey, args[2].slice('project:'.length));
    }
    return manage(...args);
  };
  const manage: typeof companion.manage = async (...args) => {
    managing.current = true;
    await companion.manage(...args);
    const live = companionStore.getState();
    // session.create 无论成败都收层（fix6-②，build 37「点了没反应」）：成功要进新会话；
    // 失败时抽屉/弹层正盖在提示条上，不收层失败反馈等于没有。
    if (args[0] === 'session.create' || (!live.pending && live.status === 'connected')) {
      state.navigate('new');
    }
  };
  useEffect(() => {
    if (managing.current && !companion.pending && !companion.busy) {
      managing.current = false;
      if (companion.status === 'connected') store.getState().navigate('new');
    }
  }, [companion.pending, companion.busy, companion.status, store]);
  const finishPair = async (raw?: string) => {
    const ui = store.getState();
    const draftKey = ui.draftKey;
    const draft = ui.preferences.drafts[draftKey] ?? '';
    await companionStore.getState().pair(raw);
    const result = companionStore.getState();
    // 配对成功一律落到会话页：有会话进会话，只授权项目时是带默认项目选择器的欢迎页，不拦弹层。
    // 扫码逃生口丢掉未确认操作后，草稿要从旧会话键搬到欢迎页输入框（design.md §13）。
    if (result.status === 'connected') {
      store.getState().navigate('new');
      if (result.abandonedPending && draft) {
        // 欢迎页输入框里已经打着的字不整段盖掉：旧会话草稿换行接在后面，为空才直接写入
        // （ai-review Nit）。扫码前就停在欢迎页（同一键取的草稿）不复读一遍。
        const current = store.getState().preferences.drafts.new ?? '';
        if (draftKey !== 'new') {
          // 搬走后清掉旧键的草稿：不清的话回到旧会话/演示页，同一段字出现两次（ai-review Nit）。
          store.getState().activateDraft(draftKey);
          store.getState().editDraft('');
        }
        store.getState().activateDraft('new');
        store.getState().editDraft(current && draftKey !== 'new' ? `${current}\n${draft}` : draft);
      }
    }
  };
  const pairAndOpenConversation = async () => {
    if (!ports.companion) return;
    let raw: string;
    try { raw = await ports.companion.scan(); }
    catch {
      // 扫码器开着的那段时间，前台自动重连可能已把通道连上（连上后 markSyncOk 停定时器）：
      // 此刻取消扫码若无条件落 offline+connectionScanFailed，会把活连接覆盖成离线，且
      // 定时器已停、connectionScanFailed 又挡 armAutoRetry，卡死到手动操作（ai-review Important）。
      // 取消本身不说明连接死了：只在确实没有可用连接时才落扫码失败态，连着就当无事发生。
      if (companionStore.getState().status !== 'connected') {
        companionStore.setState({ status: 'offline', connectionError: 'connectionScanFailed' });
      }
      return;
    }
    let invitation: LanInvitation;
    try { invitation = parseInvitation(raw); }
    catch { await finishPair(raw); return; }
    if (!invitation.verify) { await finishPair(raw); return; }
    setPendingInvite({ raw, invitation });
    if (store.getState().sheet) store.getState().pushSheet('pairConfirm');
    else store.getState().openSheet('pairConfirm');
  };
  const confirmPendingInvite = async () => {
    const pending = pendingInvite;
    setPendingInvite(null);
    store.getState().back();
    if (pending) await finishPair(pending.raw);
  };
  const dismissPendingInvite = () => {
    setPendingInvite(null);
    store.getState().back();
  };

  const settleDrawer = (target: 'open' | 'close') => {
    // 目标态先落（open 时层保持挂载），transform 带 transition 滑过去；动画时长后清 pan，
    // close 到那一刻才 closeDrawer 卸载层。settle 的 260ms 窗口内忽略新手势。
    if (target === 'open') state.openDrawer();
    setPan(current => ({ dx: current?.dx ?? 0, settle: target }));
    clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      setPan(null);
      if (target === 'close') state.closeDrawer();
    }, DRAWER_SETTLE_MS);
  };
  const gestureStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || state.sheet || pan || keyboardVisible.current || recording.current || textSelected()) return;
    // 抽屉开着时层内任何位置（含会话按钮）都可起手左拖关闭——按钮没有横滑语义，点按不受影响
    //（没有位移就不锁轴，touchend 直接放过）。关闭态下按钮/input 的起手仍归控件本身。
    if ((event.target as Element).closest('button,input,textarea,[data-testid="history"]') && !state.drawer) return;
    swipe.current = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: event.timeStamp, axis: null };
  };
  const gestureMove = (event: React.TouchEvent) => {
    const track = swipe.current;
    const touch = event.touches[0];
    if (!track || !touch) return;
    const dx = touch.clientX - track.x;
    const dy = touch.clientY - track.y;
    if (!track.axis) {
      const axis = gestureAxis(dx, dy, track.x < EDGE_GESTURE_START_X);
      if (!axis) return;
      // 竖滑让位滚动：清掉跟踪，原生滚动照常吃这次手势（缘区只降横滑门槛，不抢竖滑）。
      if (axis === 'vertical') { swipe.current = null; return; }
      track.axis = axis;
    }
    track.lastX = touch.clientX; track.lastT = event.timeStamp;
    setPan({ dx, settle: null });
  };
  const gestureEnd = (event: React.TouchEvent) => {
    const track = swipe.current; swipe.current = null;
    const touch = event.changedTouches[0];
    if (!track || !track.axis || !touch || textSelected()) return;
    // 拖拽成立：随后的合成 click 是拖拽的副产品，吞掉（轻点没锁轴、不走这里，照常点按）。
    if (shouldSwallowClick(track.axis)) {
      clearTimeout(swallowTimer.current);
      swallowClick.current = true;
      swallowTimer.current = window.setTimeout(() => { swallowClick.current = false; }, CLICK_SWALLOW_MS);
    }
    const dx = touch.clientX - track.x;
    // 末帧速度：dt 为 0（没触发过 move 或同帧松手）按慢拖处理，速度判据让位给过半。
    const dt = event.timeStamp - track.lastT;
    const vx = dt > 0 ? (touch.clientX - track.lastX) / dt : 0;
    settleDrawer(drawerPanState(dx, vx, state.drawer, drawerWidthPx(window.innerWidth)));
  };
  const gestureCancel = () => {
    // 系统夺走手势（来电/控制中心）：松不开也不许卡在半开——按当前态回弹。
    swipe.current = null;
    if (pan) settleDrawer(state.drawer ? 'open' : 'close');
  };
  if (!state.ready) return <div className="loading" role="status"><p>{state.loadError ? text.loadError : text.loading}</p>
    {state.loadError && <button className="inline-retry" onClick={() => void state.hydrate()}>{text.retry}</button>}</div>;

  return <div className="app" data-theme={theme} onTouchStart={gestureStart} onTouchMove={gestureMove} onTouchEnd={gestureEnd} onTouchCancel={gestureCancel}
    onClickCapture={event => {
      if (!swallowClick.current) return;
      // capture 阶段拦在根上：拖拽副产品的 click 到不了会话按钮/scrim；吞一次即复位，
      // 窗口内后续的真实点按不受影响。
      event.preventDefault();
      event.stopPropagation();
      swallowClick.current = false;
    }}>
    <main className="conversation" inert={state.drawer || !!state.sheet}>
      <header className="topbar"><button aria-label={text.sessions} data-testid="open-drawer" onClick={state.openDrawer}><AppIcon name="menu" /></button>
        <strong>{companion.sessionId ? companion.library?.sessions.find(s => s.id === companion.sessionId)?.title ?? (hostKey ? state.preferences.sessionTitles?.[`${hostKey}:${companion.sessionId}`] : undefined) ?? `${text.sharedSession} ${(companion.binding?.scope.indexOf(companion.sessionId) ?? 0) + 1}` : state.route === 'new' ? text.neo : text.fixture}</strong><button aria-label={text.more} data-testid="open-more" onClick={() => state.openSheet('more')}><AppIcon name="more" /></button></header>
      {state.route === 'fixture' && fixtures ? <VirtualHistory text={text} /> : companion.sessionId && (companion.history[companion.sessionId]?.messages.length || companion.history[companion.sessionId]?.nextOffset != null || companion.artifacts.length || companion.events.some(event => event.sessionId === companion.sessionId))
        ? <CompanionConversation history={companion.history[companion.sessionId]} loadMore={() => void companion.loadHistory(companion.sessionId!, true)} hidePendingApprovals events={companion.events} artifacts={companion.artifacts} sessionId={companion.sessionId} text={text} composerHeight={composerHeight}
          offline={companion.status !== 'connected'}
          openModel={openModelSheet}
          sessionModel={companion.library?.sessions.find(s => s.id === companion.sessionId) ?? null}
          // 执行条平时只说「哪一次在跑」；停止在输入区那个键上。录音面板顶掉输入区时才把
          // stop 交给它，避免运行中一开录音就没法停（grok ai-review PR#1903 Nit①）。
          running={companion.runId
            ? (voiceActive ? { stop: () => void companion.stop(), stopDisabled: companion.busy || companion.pending || companion.status !== 'connected' } : {})
            : null}
          disabled={companion.busy || companion.pending || companion.status !== 'connected'} respond={companion.respond}
          respondQuestion={companion.respondQuestion} respondPlan={companion.respondPlan}
          openArtifact={id => void companion.previewArtifact(id).then(() => {
            if (companionStore.getState().preview) store.getState().openSheet('preview');
          })} />
        // 空会话与无会话都只留一句 + 项目选择器（design.md §11/§12，爸 09-17）。空会话的选择器写它自己所在的项目；
        // 不自动聚焦输入区：手机上未经点按就弹键盘会顶走视口。
        : <div data-testid={companion.sessionId ? 'session-empty' : undefined} className="welcome"><NeoBrandMark variant="mark" size={47} />
          <h1>{text.welcome}</h1>
          {companion.library && (() => {
            const projectId = companion.sessionId ? companion.library.sessions.find(s => s.id === companion.sessionId)?.projectId ?? newTaskProjectId : newTaskProjectId;
            const project = companion.library.projects.find(p => p.id === projectId);
            const label = project ? projectDisplayName(project, companion.library.projects) : text.noCreatableProject;
            return <button className="project-pick" data-testid="project-pick" aria-label={`${text.chooseProject} · ${label}`} onClick={() => state.openSheet('projects')}>
              <AppIcon name="folder" /><span>{label}</span><AppIcon name="down" /></button>;
          })()}
        </div>}
      <div className="composer-area" ref={composerArea}>
        {/* 本会话的审批优先在托盘里就地给控件——CompanionConversation 被传了
            hidePendingApprovals，它不会再渲染 pending 卡片，所以这里是本会话审批**唯一**的
            落点。原写法只看全局第一条：会话 A 先有一条没处理的审批时，在会话 B 触发的审批
            既不在对话里、也不在托盘里，B 的 run 在手机上没有任何 approve/deny 可点，
            用户得先猜到要去 A 处理完才能回来。别的会话那条仍然给一个跳转按钮，不互相挤掉。 */}
        {(trayCard || otherDecision) && <div className="approval-tray" aria-live="polite">
          {trayCard?.kind === 'approval' && <ApprovalCard card={trayCard} text={text} disabled={companion.busy || companion.pending || companion.status !== 'connected'}
            respond={decision => companion.respond(String(trayCard.requestId), decision)} />}
          {trayCard?.kind === 'question' && <QuestionCard card={trayCard} text={text} disabled={companion.busy || companion.pending || companion.status !== 'connected'}
            respond={answers => companion.respondQuestion(String(trayCard.requestId), answers)}
            skip={reason => companion.respondQuestion(String(trayCard.requestId), {}, true, reason)} />}
          {trayCard?.kind === 'plan' && <PlanCard card={trayCard} text={text} disabled={companion.busy || companion.pending || companion.status !== 'connected'}
            respond={(decision, feedback) => companion.respondPlan(String(trayCard.requestId), decision, feedback)} />}
          {otherDecision && <button className="primary" onClick={() => selectSession(String(otherDecision.sessionId))}>{
            otherDecision.kind === 'question' ? text.reviewQuestion : otherDecision.kind === 'plan' ? text.reviewPlan : text.reviewApproval
          }</button>}
        </div>}
        {fixtures && <p className="caption">{text.fixtureNotice}</p>}
        <Composer key={`${companion.binding?.hostKey}:${companion.sessionId}`} text={text}
          draft={state.preferences.drafts[state.draftKey] ?? ''} editDraft={state.editDraft}
          // 暂停不是离线：胶囊那边显示已连接，占位却说「先写下来，连接后再发送」就自相矛盾
          // （grok ai-review Nit，正是爸看到的那张后台快照）。
          offline={!!companion.binding && companion.status !== 'connected' && !companion.paused}
          sendDisabled={!(state.preferences.drafts[state.draftKey] ?? '').trim() || companion.busy || companion.pending}
          // 停止的落点收进输入区那个键（N-MOBILE-SEND-IS-STOP）；执行条只剩「哪一次在跑」。
          running={companion.runId ? { stop: () => void companion.stop(), stopDisabled: companion.busy || companion.pending || companion.status !== 'connected' } : null}
          send={() => {
            if (state.route === 'fixture') state.attemptSend();
            else if (canAddressSession(companion)) void companion.send((state.preferences.drafts[state.draftKey] ?? ''));
            // 连着但没选会话：直接在所选项目建会话再发（N-MOBILE-DEFAULT-PROJECT），不拦截、不出报错行。
            else if (needsLibraryPick(companion)) sendAsNewSession();
            else state.attemptSend();
          }}
          status={composerStatusItems(text, { ...companion, binding: !!companion.binding, saveError: state.saveError, nativeError, sendAttempted: state.sendAttempted, voiceFailureShown, pendingSlow }, {
            flush: () => void state.flush(), reconnect: () => void companionStore.getState().reconnect({ resetBackoff: true }), scan: () => void pairAndOpenConversation(),
            openRemote: () => state.openSheet('remote'), retryCreate: lastCreate.current, switchModel: openModelSheet,
            dismissAbandoned: () => companionStore.getState().dismissAbandonedPending(),
          })}
          // 模型入口只留这一个（爸 2026-09-16 拍板）：会话操作弹窗里不再有模型那一格。
          modelLabel={sessionModelLabel} openModel={openModelSheet}
          openSettings={() => void (ports.notifications ?? unavailableNotificationPort).openSettings()}
          attach={ports.files && (() => state.openSheet('attachment'))}
          attachDisabled={!canAddressSession(companion) || companion.busy || companion.pending}
          attachments={companion.uploadProgress}
          retryAttachment={id => { void companion.retryUpload(id); }}
          removeAttachment={companion.removeUpload}
          recorder={companion.sessionId ? ports.recorder : undefined}
          transcribe={(audio, continuation, take) => companion.transcribe(audio, companion.sessionId!, companion.binding!.hostKey, continuation, take)}
          discardPendingTranscript={companion.discardPendingTranscript}
          commitSpoken={(text, continuation, take, sentenceId) => companion.commitDictation(text, continuation, take, sentenceId)}
          dictation={companion.binding?.dictation === true && companion.status === 'connected'
            ? {
              available: true,
              open: companion.dictationOpen,
              audio: companion.dictationAudio,
              stop: companion.dictationStop,
              close: companion.dictationClose,
            }
            : undefined}
          voiceDisabled={companion.status !== 'connected' || companion.busy || companion.pending}
          voicePending={companion.pending} voiceResult={companion.voiceResult}
          voiceReady={canAddressSession(companion)}
          onVoiceState={({ recording: active, failed }) => { recording.current = active; setVoiceActive(active); setVoiceFailureShown(failed); }} />
      </div>
    </main>
    {(state.drawer || pan) && (() => {
      // 拖拽/回弹期间用 --drawer-x 驱动 1:1 跟手；settle 时目标是端点（0 / -width），
      // CSS transition 从当前视觉位置滑过去。遮罩透明度 = 可见比例。
      const width = drawerWidthPx(window.innerWidth);
      const offset = pan
        ? pan.settle === 'open' ? 0 : pan.settle === 'close' ? -width : drawerPanOffset(pan.dx, width, state.drawer)
        : 0;
      return <div className="drawer-layer" data-testid="drawer-layer" inert={!!state.sheet} data-settling={pan?.settle ?? undefined}
        style={(pan ? { '--drawer-x': `${offset}px`, '--scrim-alpha': String(Math.max(0, Math.min(1, 1 + offset / width))) } : {}) as React.CSSProperties}>
        <button className="scrim" aria-label={text.closeDrawer} onClick={state.closeDrawer} />
      <aside className="drawer" aria-label={text.sessions}>
        <div className="drawer-functions"><header><strong>{text.neo}</strong>{<button aria-label={text.newSession} data-testid="new-session" onClick={() => companion.binding ? startDefaultSession() : state.navigate('new')}><AppIcon name="plus" /></button>}</header>
          <button onClick={() => companion.binding ? startDefaultSession() : state.navigate('new')}>{text.newSession}</button>
          <button onClick={() => state.openSheet('projects')}>{text.projects}</button><button onClick={() => state.openSheet('remote')}>{text.remote}</button></div>
        <nav className="drawer-history" aria-label={text.history}><p className="group-title">{text.history}</p>
          {companion.library?.sessions.map(session => <button key={session.id} data-testid={`session-${session.id}`} data-session-id={session.id} aria-current={session.id === companion.sessionId ? 'page' : undefined} onClick={() => selectSession(session.id)}>{session.title}{session.archived ? ` · ${text.archived}` : ''}</button>)}
          {companion.library?.nextOffset != null && <button onClick={() => void companion.refreshLibrary(true)}>{text.loadHistory}</button>}
          {fixtures ? Array.from({ length: 60 }, (_, n) => <button key={n} onClick={() => state.navigate('fixture')} data-testid={n === 0 ? 'fixture-session' : undefined}>{text.fixture} {n + 1}</button>) : !companion.library?.sessions.length && <p className="caption">{text.emptyHistory}</p>}
        </nav>
        <button className="personal-bar" aria-label={text.personal} data-testid="open-settings" onClick={() => state.openSheet('settings')}>
          <span className="avatar">{(state.preferences.nickname || text.guest).slice(0, 1)}</span><strong>{state.preferences.nickname || text.guest}</strong><AppIcon name="settings" />
        </button>
      </aside>
      </div>;
    })()}
    {state.sheet && currentPage && <SheetHost page={currentPage}
      title={currentPage === 'projects' ? text.chooseProject
        : currentPage === 'model' ? text.chooseModel
        : currentPage === 'projectSessions' ? sessionProject && companion.library ? projectDisplayName(sessionProject, companion.library.projects) : text.projectSessions
        : text[currentPage]}
      hasParent={state.sheet.pages.length > 1}
      close={() => {
        if (currentPage === 'preview') companion.closePreview();
        if (currentPage === 'pairConfirm') setPendingInvite(null);
        state.closeSheet();
      }} back={() => {
        if (currentPage === 'preview') companion.closePreview();
        if (currentPage === 'pairConfirm') setPendingInvite(null);
        state.back();
      }} text={text}>
      {pendingDecisions.length > 0 && <button className="primary" onClick={() => selectSession(String(pendingDecisions[0].sessionId))}>{
        pendingDecisions[0].kind === 'question' ? text.reviewQuestion : pendingDecisions[0].kind === 'plan' ? text.reviewPlan : text.reviewApproval
      }</button>}
      {(currentPage === 'projects' || currentPage === 'projectSessions' || currentPage === 'more' || currentPage === 'model') && companion.binding ? (
        companion.library ? <LibrarySheet key={`${currentPage}:${companion.sessionId}`} library={companion.library} sessionId={companion.sessionId} text={text}
          mode={currentPage === 'more' || currentPage === 'model' ? currentPage : currentPage === 'projectSessions' ? 'projectSessions' : 'projects'}
          projectId={sessionProjectId} busy={companion.busy || companion.pending || companion.status !== 'connected'} select={selectSession} manage={sheetManage}
          loadMore={() => void companion.refreshLibrary(true)} openProjectSessions={openProjectSessions} />
          // fix4-④：等库 = spinner + 一句「正在连接电脑…」（秒级超时兜底，不无限转圈）；
          // 失败 = 状态页（标题 + 诊断句 + 主按钮重新连接 + 次按钮去连接电脑），不再用
          // 「一行文案 + 行尾 pill」。行尾重试 pill 只保留在会话页断网 banner 单行场景。
          : sheetLibraryStatus(companion, libraryTimedOut) === 'unreachable'
            ? <div className="sheet-fail" role="status" data-testid="sheet-unreachable">
              <strong>{text.cannotReachComputer}</strong>
              <p>{companion.status === 'storageError' ? text.secureStorageError : connectionDiagnosis(text, companion).sentence}</p>
              <button className="primary" onClick={retrySheetLibrary}>{text.reconnect}</button>
              <button className="sheet-secondary" onClick={() => state.pushSheet('remote')}>{text.goRemote}</button>
            </div>
            : <p className="notice sheet-wait" role="status"><span className="spinner" aria-hidden="true" />{text.libraryLoading}</p>
      ) : currentPage === 'preview' && companion.preview ? <div className="preview-pane">
        <p className="caption">{text.previewHint}</p>
        <PreviewMedia name={companion.preview.name} mimeType={companion.preview.mimeType} bytes={companion.preview.bytes} text={text}
          onSave={companion.savedPreview ? undefined : () => void companion.savePreview()} />
        {/* 保存失败必须报在预览面板里——composer 区的提示被模态弹层遮住且 inert，用户看不到。 */}
        {!companion.savedPreview && commandNotice && <p role="status" className="notice">{commandNotice}</p>}
        {companion.savedPreview ? <p role="status">{companion.savedPreviewName && companion.savedPreviewName !== companion.preview.name ? `${text.savedToDevice}：${companion.savedPreviewName}` : text.savedToDevice}</p>
          : <button className="primary" onClick={() => void companion.savePreview()}>{text.saveToDevice}</button>}
      </div> : currentPage === 'remote' ? (() => {
        // fix4-③：连接电脑 sheet 重构成状态机，一态一主操作。Wi-Fi 说明书两段删掉——
        // 连不上时诊断句（三分类，见 connectionDiagnosis）已把「下一步做什么」说清。
        // 连接中只有 spinner + 一句话，不许同时出现「重新连接」按钮（按了也是重来一遍）。
        const diagnosis = connectionDiagnosis(text, companion);
        const hostName = companion.binding
          ? invitationHostLabel(companion.binding) ?? new URL(companion.binding.endpoint).hostname
          : null;
        return <div className="settings-group remote-sheet">
          {companion.status === 'connected' && companion.binding ? <>
            <div className="connection-success" role="status">
              <span className="connection-check"><AppIcon name="check" /></span>
              <strong>{hostName}</strong>
              <p>{lastSyncCopy(text, companion.lastSyncAt, Date.now()) ?? text.connectedNext}</p>
              {companion.transport === 'relay' && <p className="caption">{text.connectionViaRelay}</p>}
            </div>
            <button className="primary" onClick={() => state.navigate('new')}>{text.enterConversation}</button>
          </>
          : companion.status === 'connecting' && !companion.autoRetrying ? <div className="remote-state" role="status" data-testid="remote-connecting">
            <span className="spinner" aria-hidden="true" />{text.libraryLoading}
          </div>
          : !companion.binding ? <div className="remote-failed" role="status" data-testid="remote-unpaired">
            <strong>{text.noComputers}</strong>
            {/* 没配对过也会失败：扫码没成、本机安全存储读不出。标题仍是「还没连接电脑」，但原因要说出来，
                否则存储故障被说成「没有电脑」，用户照着再扫也好不了（ai-review PR#1814 Important④）。 */}
            {(companion.status === 'storageError' || companion.connectionError) && <p>{companion.status === 'storageError' ? text.secureStorageError : diagnosis.sentence}</p>}
            <button className="primary" disabled={!ports.companion} onClick={() => void pairAndOpenConversation()}>{text.scan}</button>
          </div>
          : <div className="remote-failed" role="status" data-testid="remote-unreachable">
            <strong>{text.cannotReachComputer}</strong>
            <p>{companion.status === 'storageError' ? text.secureStorageError : diagnosis.sentence}</p>
            {companion.pending && <p className="caption" data-testid="remote-pending-hint">{text.pendingScanHint}</p>}
            {/* 两个动作都留着，主次由诊断决定（爸 2026-09-16 build 42 真机「手机没给我扫的按钮啊」）。
                原来按分类只渲染一个：relay 被拒判 reconnect ⇒ 只有「重新连接」。而重连试的是配对时
                写死的 endpoint/altEndpoint，换网后两个都死，**这个主按钮永远不可能成功**，用户却
                拿不到唯一能救的那个动作（重新扫码），只能删 app 重装。fix4-③ 要删的是 Wi-Fi 说明书，
                不是逃生口——「一态一主操作」说的是主次，不是只留一个。 */}
            {/* 自动重试的在途连接不锁这两个键（D3）：在途 hello 约 10s 才超时，锁着等于约八成时间
                没有逃生口。扫码走 preempt 抢占；「重新连接」立即开新尝试，旧在途尝试按代号丢弃
                迟到结果。手动点按发起的连接/扫码仍锁（防重复点击）。 */}
            {([diagnosis.action, diagnosis.action === 'scan' ? 'reconnect' : 'scan'] as const).map((action, index) => action === 'scan'
              ? <button key={action} className={index === 0 ? 'primary' : 'sheet-secondary'} data-testid="remote-action-scan"
                disabled={!ports.companion || (companion.busy && !companion.autoAttempt)} onClick={() => void pairAndOpenConversation()}>{text.scan}</button>
              : <button key={action} className={index === 0 ? 'primary' : 'sheet-secondary'} data-testid="remote-action-reconnect"
                disabled={!ports.companion || (companion.busy && !companion.autoAttempt)} onClick={() => void companionStore.getState().reconnect({ resetBackoff: true })}>{text.reconnect}</button>)}
            {/* 连扫码也过不去时的底：丢掉本机存的配对，回到「尚未连接电脑」。
                不加二次确认弹层，但**必须把代价写在旁边**：初版注释写的「误点没有东西可丢」是错的
                （grok ai-review Nit②）——电脑只是睡着、Neo 只是没开时配对仍然有效，误点会连本机
                会话缓存一起丢，且只能重新扫码才能回来（要人走到电脑跟前）。代价说清了，用户才
                有得选；用一句错的理由把确认省掉，是把风险藏起来而不是降下去。
                置灰判据与上面两个键一致（busy && !autoAttempt，ai-review Nit）：自动重连在途的
                时间占比高，兜底键跟着 busy 时灰时亮等于时有时无；自动尝试在途时点击走抢占。 */}
            <button className="sheet-secondary" data-testid="remote-action-forget"
              disabled={!ports.companion || (companion.busy && !companion.autoAttempt)} onClick={() => void companion.forget()}>{text.forgetComputer}</button>
            <p className="caption" data-testid="remote-forget-caption">{text.forgetComputerHint}</p>
          </div>}
          {!ports.companion && <p>{text.nativeConnectionOnly}</p>}
        </div>;
      })() : currentPage === 'pairConfirm' && pendingInvite ? <PairConfirm
        name={invitationHostLabel(pendingInvite.invitation) ?? text.pairConfirmComputer}
        verify={deriveInvitationVerify(pendingInvite.invitation.psk, pendingInvite.invitation.hostKey)}
        text={text} onConfirm={() => void confirmPendingInvite()} onReject={dismissPendingInvite}
      /> : (currentPage === 'attachment' || currentPage === 'cameraDenied') ? <AttachmentSheet
        mode={currentPage} text={text}
        onPick={kind => {
          if (!ports.files) return;
          void pickAttachment(ports.files.pick, kind, file => companionStore.getState().upload(file)).then(outcome => {
            if (outcome === 'denied') {
              if (store.getState().sheet) store.getState().pushSheet('cameraDenied');
              else store.getState().openSheet('cameraDenied');
              return;
            }
            if (outcome === 'too-large') {
              store.getState().closeSheet();
              companionStore.setState({ commandError: 'UPLOAD_TOO_LARGE' });
              return;
            }
            if (outcome === 'type-denied') {
              store.getState().closeSheet();
              companionStore.setState({ commandError: 'COMPANION_FILE_TYPE_DENIED' });
              return;
            }
            if (outcome === 'picked') store.getState().closeSheet();
          }).catch(() => { /* camera plugin failures are not upload failures */ });
        }}
        onOpenSettings={() => void (ports.notifications ?? unavailableNotificationPort).openSettings()}
      /> : <SettingsPage page={currentPage} text={text} appearance={state.preferences.appearance} nickname={state.preferences.nickname}
        profileDraft={state.profileDraft} appInfo={appInfo} open={state.pushSheet} chooseAppearance={state.setAppearance}
        editProfile={state.editProfile} saveProfile={state.saveProfile}
        storage={{ previewBytes: companion.cacheUsage?.previewBytes ?? 0, conversationBytes: companion.cacheUsage?.conversationBytes ?? 0, result: cacheResult, confirm: cacheConfirm,
          onConfirm: () => setCacheConfirm(true),
          onClear: () => { companion.clearCache(); setCacheResult('clean'); setCacheConfirm(false); } }}
        notifications={{
          preference: notify.preference, osPermission: notify.osPermission, registration: notify.registration, lastFailure: notify.lastFailure,
          onToggle: value => void notifyStore.getState().setPreference(value),
          onRequest: () => void notifyStore.getState().requestFromUser(),
          onOpenSettings: () => void (ports.notifications ?? unavailableNotificationPort).openSettings(),
        }} />}
    </SheetHost>}
  </div>;
}
