import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  Lock,
  MessageSquarePlus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useI18n } from '../../hooks/useI18n';
import { useLiveAgentPointer } from '../../hooks/useLiveAgentPointer';
import { useSurfaceLiveFrames } from '../../hooks/useSurfaceLiveFrames';
import { useWorkbenchBrowserSession } from '../../hooks/useWorkbenchBrowserSession';
import { getPersistedSurfaceTerminalFrame } from '../../services/surfaceExecutionClient';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppshotsStore } from '../../stores/appshotsStore';
import {
  selectSurfaceExecutionRunSessionV1,
  selectActiveBrowserSurfaceSessionV1,
  useSurfaceExecutionStore,
} from '../../stores/surfaceExecutionStore';
import {
  isUserOpenedSurfaceV1,
  surfaceExecutionScopeKeyV1,
} from '../../utils/surfaceExecutionProjection';
import {
  formatSurfaceExecutionCopy,
  getSurfaceExecutionTranslations,
} from '../../i18n/surfaceExecution';
import type { SurfaceExecutionTranslationsV1 } from '../../i18n/surfaceExecution';
import { Button, GhostButton, IconButton, Input } from '../primitives';
import { ConfirmDialog } from '../composites/ConfirmDialog';
import { AgentPointerOverlay } from './AgentPointerOverlay';
import { BrowserAgentWindowOverflowMenu } from './BrowserAgentWindowOverflowMenu';
import {
  closeUserBrowserLinkRun,
  controlUserBrowserHistory,
  openHttpLinkInRailAsync,
  setUserBrowserViewport,
} from '../../services/userBrowserLink';
import { useBrowserStageUserInput } from '../../hooks/useBrowserStageUserInput';
import { BROWSER_STAGE_VIEWPORT } from '@shared/constants';
import { resolveStageFollowPlan } from '@shared/utils/browserStageViewportFollow';
import { normalizeBrowserAddressInput } from '../../utils/browserAddressBar';
import { formatAddressBarDisplay, extractBrowserHostname } from '../../utils/browserAddressDisplay';
import {
  createNavigationPending,
  failNavigationPending,
  navigationTargetSettled,
  shouldRestoreAddressOnBlur,
  type BrowserNavigationPending,
} from '../../utils/browserNavigationPending';
import { resolveBrowserToolbarState } from '../../utils/browserToolbarState';
import {
  buildBrowserAnnotationCapture,
  buildBrowserAnnotationMessageText,
  stampPinsOnScreenshot,
  type BrowserAnnotationPin,
} from '../../utils/browserAnnotation';
import { openExternalLink } from '../../utils/platform';

// B1-R·R1：workbench「浏览器」tab = **一扇浏览器**，不是状态卡片堆。
// 一条细 chrome（状态点 + 标题 + ⋯）压顶，其下是用户地址栏（2026-08-04 工单，URL 显示
// 唯一源），剩下全给实时画面；指针叠加直接画在画面上。profile 导入 / 扩展目录 /
// relay 启停 / 清 cookie 等高级管理仍只在 LocalOps，从 ⋯ 深链过去。
// 二期：导航 pending（N1）+ 工具条（N2）+ 批注发 Agent（N3）。
// P1 账号态：⋯ 菜单 Cookie 导入见 BrowserAgentWindowOverflowMenu。

type Copy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow'];

function formatTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    vars[key] !== undefined ? String(vars[key]) : match
  ));
}

/** 摘要卡用时：startedAt → projection updatedAt（裁定用 updatedAt，cleanup completedAt 依赖事件到达） */
function formatTerminalDuration(
  startedAt: number,
  updatedAt: number,
  copy: SurfaceExecutionTranslationsV1['terminal'],
): string {
  const seconds = Math.max(0, Math.round((updatedAt - startedAt) / 1000));
  if (seconds < 60) return formatSurfaceExecutionCopy(copy.durationSeconds, { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatSurfaceExecutionCopy(copy.durationMinutes, { count: minutes });
  return formatSurfaceExecutionCopy(copy.durationHours, { count: Math.round(minutes / 60) });
}

export const BrowserAgentWindow: React.FC = () => {
  const { t, language } = useI18n();
  const copy = t.workbenchTabs.agentWindow;
  const surfaceCopy = getSurfaceExecutionTranslations(language);
  const browserSession = useWorkbenchBrowserSession();
  const livePointer = useLiveAgentPointer('browser');
  const openLocalOpsPanel = useAppStore((state) => state.openLocalOpsPanel);
  const workingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  // 节流护栏的「可见」判据取自 store，不靠「组件挂载了就等于看得见」——右栏收起时
  // 视图仍可能挂着，那种情况下开流就是后台无人看还在烧 CPU。
  const activeWorkbenchTab = useAppStore((state) => state.activeWorkbenchTab);
  const workbenchCollapsed = useAppStore((state) => state.workbenchCollapsed);

  useEffect(() => {
    if (workbenchCollapsed && currentSessionId) {
      void closeUserBrowserLinkRun(currentSessionId, 'user');
    }
  }, [currentSessionId, workbenchCollapsed]);

  const openAdvancedPanel = useCallback(() => openLocalOpsPanel('browser'), [openLocalOpsPanel]);

  const {
    managedSession, preview, ownedByCurrentSession,
    browserSurfaceSessionId, browserSurfaceTitle, browserSurfaceOrigin,
  } = browserSession;
  // 终态留影：展示层改用**含终态**的选择器拿会话（开流入参仍是上面排除终态的那个，
  // 护栏不动）。只在「没有活跃 browser 会话 且 选中的是终态 browser 会话」时进留影/摘要卡。
  const displaySurfaceSession = useSurfaceExecutionStore((state) => (
    selectSurfaceExecutionRunSessionV1(state.sessionsByScope, { conversationId: currentSessionId })
  ));
  const terminalSurfaceSession = !browserSurfaceSessionId
    && displaySurfaceSession?.session.surface === 'browser'
    && (displaySurfaceSession.session.state === 'completed'
      || displaySurfaceSession.session.state === 'failed')
    ? displaySurfaceSession
    : null;
  const terminalScopeKey = terminalSurfaceSession
    ? surfaceExecutionScopeKeyV1(terminalSurfaceSession.scope)
    : null;
  // 留影帧按 scope 键取——别的会话/别的 run 的帧隔离在别的键下，不会串现场。
  const terminalFrameDataUrl = useSurfaceExecutionStore((state) => (
    terminalScopeKey ? state.frameByScope[terminalScopeKey]?.dataUrl ?? null : null
  ));
  const terminalTarget = terminalSurfaceSession?.session.activeTarget;
  const terminalBrowserTarget = terminalTarget?.kind === 'browser' ? terminalTarget : null;
  // chrome 条必须描述**画面里那扇窗**。
  // host getManagedBrowserSession 已优先 surface 绑定实例（user-browser-link 与 agent 同窗），
  // page_load / framenavigated 会刷新 URL·title·canGoBack 并广播——managed tab 是实时真源。
  // surface origin/title 仅在 managed 尚未回填时兜底；running 仍以 surface 会话存在为准
  // （防默认单例 running=false 把状态点刷灰）。
  const managedUrl = managedSession.activeTab?.url || preview?.url || null;
  const managedTitle = managedSession.activeTab?.title || preview?.title || null;
  const running = Boolean(browserSurfaceSessionId) || managedSession.running;
  const activeTitle = managedTitle
    || (browserSurfaceSessionId ? browserSurfaceTitle : null)
    || (terminalSurfaceSession ? terminalBrowserTarget?.title ?? null : null);
  // 有机跨域跳转（如 baidu → wappass）后 managedUrl 与 surface origin 不同源是正常的
  // （同一扇窗），必须回写完整 URL；surface origin 只在 managed 空时兜底。
  const activeUrl = managedUrl
    || (browserSurfaceSessionId ? browserSurfaceOrigin : null)
    || (terminalSurfaceSession ? terminalBrowserTarget?.origin ?? null : null);
  const pointerEvent = livePointer.event || livePointer.lastEvent;
  const modeLabel = browserSession.mode === 'managed'
    ? copy.modeManaged
    : browserSession.mode === 'desktop' ? copy.modeDesktop : copy.modeNone;

  // 地址栏（2026-08-04 工单）：显示当前页 URL、可编辑回车导航。导航走 #926 同一条
  // openHttpLinkInRail 链路（UserBrowserLinkService 起 user run，与 agent run 共用同一扇
  // 物理窗），不另起 session/profile；agent 忙时先弹确认，不另造抢占协议。
  const activeBrowserSurface = useSurfaceExecutionStore((state) => (
    selectActiveBrowserSurfaceSessionV1(state.sessionsByScope, currentSessionId)
  ));
  // 「agent 忙」= 本会话有活着的 browser surface 会话且不属于用户链接 run
  // （agentId === user-browser-link 的是用户自己开的页面，接力导航无需确认）。
  const agentSurfaceBusy = Boolean(
    activeBrowserSurface && !isUserOpenedSurfaceV1(activeBrowserSurface),
  );
  const addressInputDisabled = !ownedByCurrentSession || !currentSessionId;
  const [addressDraft, setAddressDraft] = useState('');
  const [addressEditing, setAddressEditing] = useState(false);
  const [addressInvalid, setAddressInvalid] = useState(false);
  const [pendingInterruptUrl, setPendingInterruptUrl] = useState<string | null>(null);
  const [navigationPending, setNavigationPending] = useState<BrowserNavigationPending | null>(null);
  const [toolbarBusy, setToolbarBusy] = useState<'back' | 'forward' | 'reload' | null>(null);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [pins, setPins] = useState<BrowserAnnotationPin[]>([]);
  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState('');
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [annotateSending, setAnnotateSending] = useState(false);
  const [cookieImportNotice, setCookieImportNotice] = useState<{
    message: string;
    kind: 'success' | 'error';
  } | null>(null);
  const navRequestIdRef = useRef(0);
  // R4：stage CSS 尺寸跟随视口 + 帧采集分辨率
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageFollow, setStageFollow] = useState<{
    viewport: { width: number; height: number };
    capture: { maxWidth: number; maxHeight: number; quality: number };
  } | null>(null);
  const stageFollowPlanKeyRef = useRef<string>('');
  const stageViewportPushedKeyRef = useRef<string>('');

  // URL 回写：pending 优先；未编辑且无 pending 时跟随页面跳转。
  useEffect(() => {
    if (navigationPending) {
      setAddressDraft(navigationPending.url);
      return;
    }
    if (!addressEditing) setAddressDraft(activeUrl ?? '');
  }, [activeUrl, addressEditing, navigationPending]);

  // 导航落地：activeUrl 落到目标后清 pending。
  useEffect(() => {
    if (navigationPending?.status !== 'pending') return;
    if (navigationTargetSettled(activeUrl, navigationPending.url)) {
      setNavigationPending(null);
      setAddressEditing(false);
    }
  }, [activeUrl, navigationPending]);

  const navigateTo = useCallback(async (url: string, override?: { conversationId: string; workspace?: string | null }) => {
    const requestId = ++navRequestIdRef.current;
    const previousUrl = activeUrl;
    setNavigationPending(createNavigationPending(url, previousUrl));
    setAddressDraft(url);
    setAddressInvalid(false);
    try {
      await openHttpLinkInRailAsync({
        href: url,
        conversationId: override?.conversationId ?? currentSessionId,
        workspace: override?.workspace ?? workingDirectory,
      });
      // openLinkInRail resolve = host 已受理导航并回写快照——pending 到此结束
      // （2026-08-05 真机：baidu.com→www.baidu.com 跳转导致 settle 判定永假、「正在打开」卡死）。
      if (requestId === navRequestIdRef.current) {
        setNavigationPending(null);
      }
    } catch (error) {
      if (requestId !== navRequestIdRef.current) return;
      const message = error instanceof Error ? error.message : copy.navigationFailedGeneric;
      setNavigationPending(failNavigationPending(
        createNavigationPending(url, previousUrl),
        message,
      ));
    }
  }, [activeUrl, copy.navigationFailedGeneric, currentSessionId, workingDirectory]);

  const submitAddress = useCallback(() => {
    const normalized = normalizeBrowserAddressInput(addressDraft);
    if (!normalized.ok) {
      setAddressInvalid(true);
      return;
    }
    setAddressInvalid(false);
    // 立即乐观展示归一化 URL（即使还要弹中断确认）。
    setAddressDraft(normalized.url);
    // 空态自动建会话（2026-08-05 产品负责人：不该要求用户先建会话再打开网页）：
    // 无会话时静默新建一个快速会话并绑定本次导航；建会话失败才落人话失败态。
    if (!currentSessionId) {
      setNavigationPending(createNavigationPending(normalized.url, activeUrl));
      void (async () => {
        try {
          const session = await useSessionStore.getState().createSession(undefined, { workingDirectory: null });
          if (!session) throw new Error(copy.navigationNeedsSession);
          await navigateTo(normalized.url, {
            conversationId: session.id,
            workspace: session.workingDirectory ?? null,
          });
        } catch (error) {
          setNavigationPending(failNavigationPending(
            createNavigationPending(normalized.url, activeUrl),
            error instanceof Error && error.message ? error.message : copy.navigationNeedsSession,
          ));
        }
      })();
      return;
    }
    if (agentSurfaceBusy) {
      setPendingInterruptUrl(normalized.url);
      return;
    }
    void navigateTo(normalized.url);
  }, [activeUrl, addressDraft, agentSurfaceBusy, copy.navigationNeedsSession, currentSessionId, navigateTo, workingDirectory]);

  // R4：ResizeObserver 去抖上报 stage CSS → setViewport + 帧采集 max 尺寸
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = (width: number, height: number) => {
      const dpr = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio
        : 1;
      const plan = resolveStageFollowPlan({ width, height }, dpr);
      if (!plan) return;
      const planKey = `${plan.viewport.width}x${plan.viewport.height}@${plan.capture.maxWidth}x${plan.capture.maxHeight}`;
      if (stageFollowPlanKeyRef.current !== planKey) {
        stageFollowPlanKeyRef.current = planKey;
        setStageFollow(plan);
      }
      // 会话可能晚于 stage 量测就绪：单独按「会话+视口」去重推送，避免 key 已锁死零上报
      if (currentSessionId && browserSurfaceSessionId && ownedByCurrentSession) {
        const pushKey = `${currentSessionId}:${browserSurfaceSessionId}:${plan.viewport.width}x${plan.viewport.height}`;
        if (stageViewportPushedKeyRef.current !== pushKey) {
          stageViewportPushedKeyRef.current = pushKey;
          void setUserBrowserViewport({
            conversationId: currentSessionId,
            workspace: workingDirectory ?? '',
            width: plan.viewport.width,
            height: plan.viewport.height,
          }).catch(() => undefined);
        }
      }
    };
    const schedule = () => {
      const rect = el.getBoundingClientRect();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        publish(rect.width, rect.height);
      }, BROWSER_STAGE_VIEWPORT.DEBOUNCE_MS);
    };
    const observer = new ResizeObserver(() => schedule());
    observer.observe(el);
    schedule();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [
    browserSurfaceSessionId,
    currentSessionId,
    ownedByCurrentSession,
    workingDirectory,
    // 面板可见时再挂 observer；折叠时 stage 可能 0 尺寸
    activeWorkbenchTab,
    workbenchCollapsed,
  ]);

  const liveStream = useSurfaceLiveFrames({
    conversationId: currentSessionId,
    surfaceSessionId: browserSurfaceSessionId,
    visible: activeWorkbenchTab === 'browser' && !workbenchCollapsed,
    sessionRunning: Boolean(browserSurfaceSessionId),
    maxWidth: stageFollow?.capture.maxWidth ?? null,
    maxHeight: stageFollow?.capture.maxHeight ?? null,
  });

  // 三期 P1 / R4：画面交互透传（点击/滚轮/键盘/拖拽）；坐标 content 优先跟随视口 CSS。
  const stageInput = useBrowserStageUserInput({
    conversationId: currentSessionId,
    workspace: workingDirectory,
    ownedByCurrentSession,
    annotateMode,
    ready: Boolean(liveStream.frame && browserSurfaceSessionId),
    agentSurfaceBusy,
    contentWidth: stageFollow?.viewport.width
      ?? liveStream.frame?.width
      ?? managedSession.viewport?.width
      ?? null,
    contentHeight: stageFollow?.viewport.height
      ?? liveStream.frame?.height
      ?? managedSession.viewport?.height
      ?? null,
    surfaceSessionId: browserSurfaceSessionId,
  });

  // 重启/刷新后内存 frameByScope 是空的：终态会话还在（host 投影恢复），试着从盘上
  // 把留影帧读回来补进 store（标 'stale'，三态渲染自然落留影）。每个 scope 只试一次，
  // 读不到就保持摘要卡兜底，不重复打 IPC。
  const persistedFrameTriedRef = useRef<Set<string>>(new Set());
  // scope 走 ref 而不是进依赖数组：terminalSurfaceSession 来自内联 selector，每次 store
  // 变动都是**新对象**，进依赖数组会让 effect 每次渲染重跑。配上「每个 scope 只试一次」
  // 的 ref，后果是读回请求发出去了、响应也回来了，却被 cleanup 判成过期丢掉，且永不重试
  // ——真机实测正是这样：HTTP 200 帧完好，屏幕永远停在摘要卡。
  const terminalScopeRef = useRef(terminalSurfaceSession?.scope ?? null);
  terminalScopeRef.current = terminalSurfaceSession?.scope ?? null;
  useEffect(() => {
    const scope = terminalScopeRef.current;
    if (!scope || !terminalScopeKey || terminalFrameDataUrl) return;
    if (persistedFrameTriedRef.current.has(terminalScopeKey)) return;
    persistedFrameTriedRef.current.add(terminalScopeKey);
    void getPersistedSurfaceTerminalFrame({
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
    })
      .then((result) => {
        // 不设 cancelled 守卫：帧是按 scope 键写进 store 的，即便这时用户已经切走，
        // 写的也只是它自己那把键下的内容，不会串到别的现场；而丢弃它等于永久失去。
        if (!result.frame) return;
        useSurfaceExecutionStore.getState().setFrameState(scope, {
          status: 'stale',
          dataUrl: result.frame.dataUrl,
          updatedAt: Date.now(),
        });
      })
      .catch(() => undefined);
  }, [terminalScopeKey, terminalFrameDataUrl]);

  const [primaryRepair, ...secondaryRepairs] = ownedByCurrentSession
    ? browserSession.repairActions
    : [];

  const canGoBack = Boolean(managedSession.activeTab?.canGoBack);
  const canGoForward = Boolean(managedSession.activeTab?.canGoForward);
  const toolbar = resolveBrowserToolbarState({
    running,
    hasUrl: Boolean(activeUrl),
    canGoBack,
    canGoForward,
    ownedByCurrentSession,
  });

  const runHistoryAction = useCallback(async (action: 'back' | 'forward' | 'reload') => {
    // workspace 可空：host 兜底（快速对话无 cwd 时后退/刷新仍应可用，与 open 同口径）。
    if (!currentSessionId) return;
    setToolbarBusy(action);
    try {
      await controlUserBrowserHistory({
        conversationId: currentSessionId,
        workspace: workingDirectory ?? '',
        action,
      });
      await browserSession.refresh();
    } catch {
      // 工具条失败不打断现场；session refresh 已尽力。
    } finally {
      setToolbarBusy(null);
    }
  }, [browserSession, currentSessionId, workingDirectory]);

  const handleOpenExternal = useCallback(() => {
    if (!activeUrl) return;
    openExternalLink(activeUrl);
  }, [activeUrl]);

  const exitAnnotateMode = useCallback(() => {
    setAnnotateMode(false);
    setPins([]);
    setActivePinId(null);
    setPinDraft('');
    setAnnotateError(null);
    setAnnotateSending(false);
  }, []);

  const handleStageClickForAnnotate = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!annotateMode) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const xPercent = ((event.clientX - rect.left) / rect.width) * 100;
    const yPercent = ((event.clientY - rect.top) / rect.height) * 100;
    const nextIndex = pins.length === 0 ? 1 : Math.max(...pins.map((p) => p.index)) + 1;
    const id = `pin-${Date.now().toString(36)}-${nextIndex}`;
    const pin: BrowserAnnotationPin = {
      id,
      xPercent: Math.min(100, Math.max(0, xPercent)),
      yPercent: Math.min(100, Math.max(0, yPercent)),
      comment: '',
      index: nextIndex,
    };
    setPins((prev) => [...prev, pin]);
    setActivePinId(id);
    setPinDraft('');
    setAnnotateError(null);
  }, [annotateMode, pins]);

  const saveActivePinComment = useCallback(() => {
    if (!activePinId) return;
    setPins((prev) => prev.map((pin) => (
      pin.id === activePinId ? { ...pin, comment: pinDraft.trim() } : pin
    )));
  }, [activePinId, pinDraft]);

  const deleteActivePin = useCallback(() => {
    if (!activePinId) return;
    setPins((prev) => prev.filter((pin) => pin.id !== activePinId));
    setActivePinId(null);
    setPinDraft('');
  }, [activePinId]);

  const handleSendAnnotations = useCallback(async () => {
    if (pins.length === 0) {
      setAnnotateError(copy.annotateEmptyPins);
      return;
    }
    const frameDataUrl = liveStream.frame?.dataUrl || terminalFrameDataUrl;
    if (!frameDataUrl) {
      setAnnotateError(copy.annotateNeedFrame);
      return;
    }
    setAnnotateSending(true);
    setAnnotateError(null);
    try {
      saveActivePinComment();
      const pinsToSend = pins.map((pin) => (
        pin.id === activePinId ? { ...pin, comment: pinDraft.trim() } : pin
      ));
      const stamped = await stampPinsOnScreenshot(frameDataUrl, pinsToSend);
      const capture = buildBrowserAnnotationCapture({
        pins: pinsToSend,
        screenshotDataUrl: stamped,
        pageUrl: activeUrl,
        pageTitle: activeTitle,
      });
      const messageText = buildBrowserAnnotationMessageText({
        pins: pinsToSend,
        pageUrl: activeUrl,
        pageTitle: activeTitle,
      });
      useAppshotsStore.getState().setPending(capture, currentSessionId);
      // 注入 composer 文本并触发提交（ChatInput 监听 browser-annotation:submit，走 appshot 主路径）。
      window.dispatchEvent(new CustomEvent('browser-annotation:submit', {
        detail: { text: messageText },
      }));
      exitAnnotateMode();
    } catch (error) {
      setAnnotateError(error instanceof Error ? error.message : copy.navigationFailedGeneric);
      setAnnotateSending(false);
    }
  }, [
    activePinId,
    activeTitle,
    activeUrl,
    copy.annotateEmptyPins,
    copy.annotateNeedFrame,
    copy.navigationFailedGeneric,
    currentSessionId,
    exitAnnotateMode,
    liveStream.frame?.dataUrl,
    pinDraft,
    pins,
    saveActivePinComment,
    terminalFrameDataUrl,
  ]);

  const addressDisplayValue = formatAddressBarDisplay({
    raw: addressDraft,
    focused: addressEditing || Boolean(navigationPending),
  });
  const annotateHostLabel = extractBrowserHostname(activeUrl) || (activeUrl ? activeUrl : '…');

  const isNavPending = navigationPending?.status === 'pending';
  const navFailedMessage = navigationPending?.status === 'failed'
    ? formatTemplate(copy.navigationFailed, {
      error: navigationPending.error || copy.navigationFailedGeneric,
    })
    : null;

  return (
    <div
      data-testid="workbench-browser-view"
      className="flex h-full min-h-0 flex-col bg-zinc-950"
    >
      {annotateMode && (
        <div
          data-testid="browser-agent-window-annotate-banner"
          className="flex shrink-0 items-center gap-2 border-b border-badge-info/20 bg-sky-500/10 px-2.5 py-1.5"
        >
          <span className="min-w-0 flex-1 truncate text-xs text-badge-info">
            {formatTemplate(copy.annotateBanner, { host: annotateHostLabel })}
          </span>
          <Button
            variant="primary"
            size="sm"
            loading={annotateSending}
            disabled={pins.length === 0 || annotateSending}
            onClick={() => void handleSendAnnotations()}
            data-testid="browser-agent-window-annotate-send"
          >
            {formatTemplate(copy.annotateSend, { count: pins.length })}
          </Button>
          <GhostButton
            size="sm"
            onClick={exitAnnotateMode}
            data-testid="browser-agent-window-annotate-exit"
          >
            {copy.annotateExit}
          </GhostButton>
        </div>
      )}

      <div
        data-testid="browser-agent-window-addressbar"
        className="flex shrink-0 items-center gap-1 border-b border-white/[0.08] px-2 py-1.5"
      >
        <span
          data-testid="browser-agent-window-status-dot"
          title={running ? copy.running : copy.stopped}
          className={`mx-1 h-2 w-2 shrink-0 rounded-full ${
            running ? 'bg-mark-success' : 'bg-zinc-600'
          }`}
        />
        <IconButton
          icon={<ArrowLeft className="h-3.5 w-3.5" />}
          aria-label={copy.navBack}
          variant="default"
          size="sm"
          disabled={!toolbar.backEnabled || Boolean(toolbarBusy)}
          loading={toolbarBusy === 'back'}
          onClick={() => void runHistoryAction('back')}
          data-testid="browser-agent-window-nav-back"
        />
        <IconButton
          icon={<ArrowRight className="h-3.5 w-3.5" />}
          aria-label={copy.navForward}
          variant="default"
          size="sm"
          disabled={!toolbar.forwardEnabled || Boolean(toolbarBusy)}
          loading={toolbarBusy === 'forward'}
          onClick={() => void runHistoryAction('forward')}
          data-testid="browser-agent-window-nav-forward"
        />
        <IconButton
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          aria-label={copy.navReload}
          variant="default"
          size="sm"
          disabled={!toolbar.reloadEnabled || Boolean(toolbarBusy)}
          loading={toolbarBusy === 'reload'}
          onClick={() => void runHistoryAction('reload')}
          data-testid="browser-agent-window-nav-reload"
        />
        <div className="relative min-w-0 flex-1">
          <Input
            inputSize="sm"
            aria-label={copy.addressBarLabel}
            placeholder={copy.addressBarPlaceholder}
            value={addressDisplayValue}
            disabled={addressInputDisabled || isNavPending}
            title={!ownedByCurrentSession ? copy.foreignSessionHint : (addressDraft || undefined)}
            error={addressInvalid || navigationPending?.status === 'failed'}
            errorMessage={
              addressInvalid
                ? copy.addressBarInvalid
                : navFailedMessage || undefined
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setAddressDraft(event.target.value);
              if (addressInvalid) setAddressInvalid(false);
              if (navigationPending?.status === 'failed') setNavigationPending(null);
            }}
            onFocus={() => setAddressEditing(true)}
            onBlur={() => {
              setAddressEditing(false);
              setAddressInvalid(false);
              if (shouldRestoreAddressOnBlur(navigationPending)) {
                setAddressDraft(activeUrl ?? '');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitAddress();
              } else if (event.key === 'Escape') {
                event.currentTarget.blur();
              }
            }}
            data-testid="browser-agent-window-address-input"
          />
          {isNavPending && (
            <span
              data-testid="browser-agent-window-nav-spinner"
              className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-[10px] text-zinc-400"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {copy.navigatingStatus}
            </span>
          )}
        </div>
        <IconButton
          icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
          aria-label={copy.annotate}
          variant="default"
          size="sm"
          disabled={!toolbar.annotateEnabled || annotateMode}
          onClick={() => {
            setAnnotateMode(true);
            setAnnotateError(null);
          }}
          data-testid="browser-agent-window-annotate"
        />
        <IconButton
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          aria-label={copy.openExternal}
          variant="default"
          size="sm"
          disabled={!toolbar.openExternalEnabled}
          onClick={handleOpenExternal}
          data-testid="browser-agent-window-open-external"
        />
        {!ownedByCurrentSession && (
          <span
            data-testid="browser-agent-window-foreign"
            title={`${copy.foreignSessionTitle} · ${copy.foreignSessionHint}`}
            className="flex shrink-0 items-center gap-1 rounded-full border border-badge-warning/20 bg-amber-500/[0.06] px-2 py-0.5 text-[10px] text-badge-warning"
          >
            <Lock className="h-3 w-3" />
            {copy.foreignSessionTitle}
          </span>
        )}
        <BrowserAgentWindowOverflowMenu
          copy={copy}
          modeLabel={modeLabel}
          onOpenLocalOps={openAdvancedPanel}
          onImportNotice={(message, kind) => setCookieImportNotice({ message, kind })}
        />
      </div>
      {cookieImportNotice && (
        <div
          data-testid="browser-agent-window-cookie-import-notice"
          className={`flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5 text-[11px] ${
            cookieImportNotice.kind === 'success'
              ? 'border-badge-success/20 bg-emerald-500/10 text-badge-success'
              : 'border-badge-danger/20 bg-red-500/10 text-badge-danger'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{cookieImportNotice.message}</span>
          <button
            type="button"
            className="shrink-0 text-zinc-400 hover:text-zinc-200"
            onClick={() => setCookieImportNotice(null)}
            aria-label={copy.importCookiesCancel}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div
        ref={stageRef}
        data-testid="browser-agent-window-stage"
        className={`relative min-h-0 flex-1 overflow-hidden bg-black/40 outline-hidden ${
          stageInput.interactive
            ? 'cursor-default focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/50'
            : ''
        } ${stageInput.stageFocused && stageInput.interactive ? 'ring-2 ring-inset ring-sky-500/40' : ''}`}
        role={annotateMode ? 'button' : stageInput.interactive ? 'application' : undefined}
        tabIndex={annotateMode || stageInput.interactive ? 0 : undefined}
        aria-label={annotateMode ? copy.annotate : stageInput.interactive ? copy.liveInteract : undefined}
        onClick={annotateMode ? handleStageClickForAnnotate : stageInput.onStageClick}
        onPointerDown={annotateMode ? undefined : stageInput.onStagePointerDown}
        onPointerMove={annotateMode ? undefined : stageInput.onStagePointerMove}
        onPointerUp={annotateMode ? undefined : stageInput.onStagePointerUp}
        onPointerCancel={annotateMode ? undefined : stageInput.onStagePointerCancel}
        onWheel={annotateMode ? undefined : stageInput.onStageWheel}
        onKeyDown={annotateMode
          ? (event) => {
            // 批注落点依赖鼠标坐标；键盘 Enter 仅用于焦点可达，不模拟坐标落点。
            if (event.key === 'Escape') exitAnnotateMode();
          }
          : stageInput.onStageKeyDown}
        onCompositionEnd={annotateMode ? undefined : stageInput.onStageCompositionEnd}
        onFocus={() => {
          if (!annotateMode && stageInput.interactive) stageInput.setStageFocused(true);
        }}
        onBlur={() => stageInput.setStageFocused(false)}
      >
        {isNavPending && !liveStream.frame ? (
          <div
            data-testid="browser-agent-window-nav-pending"
            className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
          >
            <Loader2 className="h-5 w-5 animate-spin text-badge-info" />
            <div className="text-xs text-zinc-300">{copy.navigatingStatus}</div>
            <div className="max-w-[320px] truncate text-[11px] text-zinc-500" title={navigationPending?.url}>
              {navigationPending?.url}
            </div>
          </div>
        ) : liveStream.frame ? (
          <img
            data-testid="browser-agent-window-frame"
            src={liveStream.frame.dataUrl}
            alt={copy.livePicture}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            className="h-full w-full object-contain select-none"
            style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
          />
        ) : terminalSurfaceSession && terminalFrameDataUrl ? (
          // 终态留影：停流前移交进 store 的最后一帧，置灰 +「已结束」角标。
          <div data-testid="browser-agent-window-terminal" className="relative h-full w-full">
            <img
              data-testid="browser-agent-window-terminal-frame"
              src={terminalFrameDataUrl}
              alt={surfaceCopy.terminal.frameAlt}
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              className="h-full w-full object-contain select-none grayscale opacity-60"
              style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
            />
            <span
              data-testid="browser-agent-window-ended-badge"
              className="absolute right-2 top-2 rounded-full border border-white/10 bg-zinc-900/80 px-2 py-0.5 text-[10px] text-zinc-300"
            >
              {surfaceCopy.terminal.badge}
            </span>
          </div>
        ) : terminalSurfaceSession ? (
          // 终态无留影帧（如 reload 后）：摘要卡兜底，不回「还没有打开页面」空态谎言。
          <div
            data-testid="browser-agent-window-terminal-summary"
            className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
          >
            <span
              data-testid="browser-agent-window-ended-badge"
              className="rounded-full border border-white/10 bg-zinc-900/80 px-2 py-0.5 text-[10px] text-zinc-300"
            >
              {surfaceCopy.terminal.badge}
              {' · '}
              {surfaceCopy.state[terminalSurfaceSession.session.state]}
            </span>
            <div className="max-w-[320px] truncate text-xs text-zinc-300">
              {terminalBrowserTarget?.title || surfaceCopy.terminal.untitled}
            </div>
            {terminalBrowserTarget?.origin && (
              <div className="max-w-[320px] truncate text-[11px] text-zinc-500">
                {terminalBrowserTarget.origin}
              </div>
            )}
            <div className="text-[11px] text-zinc-600">
              {formatSurfaceExecutionCopy(surfaceCopy.terminal.duration, {
                time: formatTerminalDuration(
                  terminalSurfaceSession.session.startedAt,
                  terminalSurfaceSession.updatedAt,
                  surfaceCopy.terminal,
                ),
              })}
            </div>
          </div>
        ) : (
          <div
            data-testid="browser-agent-window-empty"
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <div className="text-xs text-zinc-400">
              {primaryRepair
                ? copy.notReadyTitle
                : liveStream.streaming
                  ? copy.connecting
                  : liveStream.unavailableReason
                    ? copy.streamUnavailable
                    : copy.idleTitle}
            </div>
            <div className="max-w-[320px] text-[11px] leading-relaxed text-zinc-600">
              {primaryRepair ? browserSession.blockedDetail || copy.idleHint : copy.idleHint}
            </div>
            {browserSession.actionError && (
              <div className="text-[11px] leading-relaxed text-badge-danger">
                {browserSession.actionError}
              </div>
            )}
            {primaryRepair && (
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  loading={browserSession.busyActionKind === primaryRepair.kind}
                  onClick={() => void browserSession.runRepairAction(primaryRepair)}
                  data-testid={`browser-agent-window-repair-${primaryRepair.kind}`}
                >
                  {primaryRepair.label}
                </Button>
                {secondaryRepairs.map((action) => (
                  <GhostButton
                    key={action.kind}
                    size="sm"
                    loading={browserSession.busyActionKind === action.kind}
                    onClick={() => void browserSession.runRepairAction(action)}
                    data-testid={`browser-agent-window-repair-${action.kind}`}
                  >
                    {action.label}
                  </GhostButton>
                ))}
              </div>
            )}
          </div>
        )}

        {annotateMode && pins.map((pin) => (
          <button
            key={pin.id}
            type="button"
            data-testid={`browser-agent-window-pin-${pin.index}`}
            className={`absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[11px] font-semibold shadow ${
              pin.id === activePinId
                ? 'border-white bg-sky-500 text-white'
                : 'border-white/80 bg-sky-600/90 text-white'
            }`}
            style={{ left: `${pin.xPercent}%`, top: `${pin.yPercent}%` }}
            onClick={(event) => {
              event.stopPropagation();
              setActivePinId(pin.id);
              setPinDraft(pin.comment);
            }}
          >
            {pin.index}
          </button>
        ))}

        {annotateMode && activePinId && (
          <div
            data-testid="browser-agent-window-pin-editor"
            className="absolute bottom-3 left-1/2 z-30 w-[min(320px,90%)] -translate-x-1/2 rounded-lg border border-white/10 bg-zinc-900/95 p-2 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400">
                pin{pins.find((p) => p.id === activePinId)?.index ?? ''}
              </span>
              <button
                type="button"
                className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
                aria-label={copy.annotateExit}
                onClick={() => {
                  setActivePinId(null);
                  setPinDraft('');
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <Input
              inputSize="sm"
              value={pinDraft}
              placeholder={copy.annotatePinPlaceholder}
              onChange={(event) => setPinDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveActivePinComment();
                  setActivePinId(null);
                }
              }}
              data-testid="browser-agent-window-pin-comment"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <GhostButton
                size="sm"
                onClick={deleteActivePin}
                data-testid="browser-agent-window-pin-delete"
              >
                {copy.annotatePinDelete}
              </GhostButton>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  saveActivePinComment();
                  setActivePinId(null);
                }}
                data-testid="browser-agent-window-pin-save"
              >
                {copy.annotatePinSave}
              </Button>
            </div>
          </div>
        )}

        {annotateError && (
          <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-md border border-red-500/30 bg-red-950/90 px-2 py-1 text-[11px] text-badge-danger">
            {annotateError}
          </div>
        )}

        {pointerEvent && !annotateMode && (
          <AgentPointerOverlay event={pointerEvent} live={livePointer.isLive} />
        )}
      </div>

      <ConfirmDialog
        isOpen={pendingInterruptUrl !== null || stageInput.pendingPreemptInput !== null}
        title={copy.interruptConfirmTitle}
        message={copy.interruptConfirmMessage}
        variant="warning"
        confirmText={
          pendingInterruptUrl
            ? copy.interruptConfirmAction
            : copy.interruptConfirmOperate
        }
        cancelText={copy.interruptConfirmCancel}
        onConfirm={() => {
          if (pendingInterruptUrl) {
            const url = pendingInterruptUrl;
            setPendingInterruptUrl(null);
            if (url) void navigateTo(url);
            return;
          }
          stageInput.confirmPreempt();
        }}
        onCancel={() => {
          setPendingInterruptUrl(null);
          stageInput.cancelPreempt();
        }}
      />
    </div>
  );
};
