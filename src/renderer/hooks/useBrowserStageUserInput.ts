import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from 'react';
import { BROWSER_STAGE_VIEWPORT } from '@shared/constants';
import { mapDisplayPointToViewport } from '@shared/utils/browserFrameCoordinateMap';
import type { UserBrowserInputPayload } from '@shared/utils/userBrowserInputPayload';
import { dispatchUserBrowserInput } from '../services/userBrowserLink';
import {
  resolveBrowserStageInteractionGate,
  shouldDispatchBrowserStageInteraction,
} from '../utils/browserStageInteractionGate';

export interface BrowserStageUserInputOptions {
  conversationId: string | null;
  workspace: string | null | undefined;
  ownedByCurrentSession: boolean;
  annotateMode: boolean;
  ready: boolean;
  agentSurfaceBusy: boolean;
  /** 实时帧/视口内容尺寸（device CSS px）；视口跟随后应等于 stage CSS */
  contentWidth: number | null;
  contentHeight: number | null;
  /** agent surface 会话 id 变化时重置抢占确认 */
  surfaceSessionId: string | null;
}

export interface BrowserStageUserInputApi {
  stageFocused: boolean;
  setStageFocused: (value: boolean) => void;
  interactive: boolean;
  pendingPreemptInput: UserBrowserInputPayload | null;
  confirmPreempt: () => void;
  cancelPreempt: () => void;
  /** 兼容旧 click 路径；拖拽优先走 pointer 序列 */
  onStageClick: (event: MouseEvent<HTMLElement>) => void;
  onStagePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onStagePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onStagePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onStagePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onStageWheel: (event: WheelEvent<HTMLElement>) => void;
  onStageKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onStageCompositionEnd: (event: React.CompositionEvent<HTMLElement>) => void;
}

interface ActivePointerGesture {
  pointerId: number;
  startDisplay: { x: number; y: number };
  startViewport: { x: number; y: number };
  lastViewport: { x: number; y: number };
  path: Array<{ x: number; y: number }>;
  dragging: boolean;
  button: 'left' | 'right' | 'middle';
}

/**
 * 画面交互透传：坐标映射 + 门控（外会话/批注/抢占）+ host dispatch。
 * 批注模式由调用方独占 onClick，本 hook 在 annotate 时 no-op。
 * R4：pointer 序列支持 drag（mousedown→path→mouseup），click 在未达阈值时发出。
 */
export function useBrowserStageUserInput(
  options: BrowserStageUserInputOptions,
): BrowserStageUserInputApi {
  const {
    conversationId,
    workspace,
    ownedByCurrentSession,
    annotateMode,
    ready,
    agentSurfaceBusy,
    contentWidth,
    contentHeight,
    surfaceSessionId,
  } = options;

  const [stageFocused, setStageFocused] = useState(false);
  const [interactionPreempted, setInteractionPreempted] = useState(false);
  const [pendingPreemptInput, setPendingPreemptInput] = useState<UserBrowserInputPayload | null>(null);
  const preemptSurfaceRef = useRef<string | null>(null);
  const gestureRef = useRef<ActivePointerGesture | null>(null);
  /** pointerup 已发过 click/drag 时吞掉随后合成的 click，避免双发 */
  const suppressNextClickRef = useRef(false);

  // agent 空闲或 surface 切换时清抢占态
  useEffect(() => {
    if (!agentSurfaceBusy) {
      setInteractionPreempted(false);
      preemptSurfaceRef.current = null;
      return;
    }
    if (preemptSurfaceRef.current && preemptSurfaceRef.current !== surfaceSessionId) {
      setInteractionPreempted(false);
      preemptSurfaceRef.current = surfaceSessionId;
    } else if (!preemptSurfaceRef.current) {
      preemptSurfaceRef.current = surfaceSessionId;
    }
  }, [agentSurfaceBusy, surfaceSessionId]);

  const gate = resolveBrowserStageInteractionGate({
    ownedByCurrentSession,
    annotateMode,
    ready,
    agentSurfaceBusy,
    interactionPreempted,
  });
  const interactive = shouldDispatchBrowserStageInteraction(gate)
    || gate === 'needs-preempt-confirm';

  const send = useCallback(async (payload: UserBrowserInputPayload) => {
    // workspace 可空：host 与 openLinkInRail 同兜底（快速对话无 cwd 仍可透传）。
    if (!conversationId) return;
    try {
      await dispatchUserBrowserInput({
        conversationId,
        workspace: workspace ?? '',
        input: payload,
      });
    } catch {
      // 透传失败不打断现场（与工具条失败策略一致）
    }
  }, [conversationId, workspace]);

  const route = useCallback((payload: UserBrowserInputPayload) => {
    const reason = resolveBrowserStageInteractionGate({
      ownedByCurrentSession,
      annotateMode,
      ready,
      agentSurfaceBusy,
      interactionPreempted,
    });
    if (reason === 'needs-preempt-confirm') {
      setPendingPreemptInput(payload);
      return;
    }
    if (!shouldDispatchBrowserStageInteraction(reason)) return;
    void send(payload);
  }, [
    agentSurfaceBusy,
    annotateMode,
    interactionPreempted,
    ownedByCurrentSession,
    ready,
    send,
  ]);

  const mapPoint = useCallback((
    event: { clientX: number; clientY: number; currentTarget: HTMLElement },
  ): { display: { x: number; y: number }; viewport: { x: number; y: number } } | null => {
    if (!contentWidth || !contentHeight) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const clientX = Number(event.clientX);
    const clientY = Number(event.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const display = {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
    const mapped = mapDisplayPointToViewport(
      display,
      { width: rect.width, height: rect.height },
      { width: contentWidth, height: contentHeight },
    );
    if (!mapped) return null;
    return { display, viewport: mapped };
  }, [contentHeight, contentWidth]);

  const onStageClick = useCallback((event: MouseEvent<HTMLElement>) => {
    // pointer 序列已处理主路径；保留 click 仅作兜底（无 pointer 环境）。
    if (annotateMode) return;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      event.preventDefault();
      return;
    }
    if (gestureRef.current) return;
    event.preventDefault();
    if (!interactive) return;
    event.currentTarget.focus();
    setStageFocused(true);
    const mapped = mapPoint(event);
    if (!mapped) return;
    const clickCount = event.detail >= 2 ? 2 : 1;
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
    route({
      kind: 'click',
      x: mapped.viewport.x,
      y: mapped.viewport.y,
      button,
      clickCount,
    });
  }, [annotateMode, interactive, mapPoint, route]);

  const onStagePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (annotateMode || !interactive) return;
    // 仅接受已知按键；button 缺省时按左键（jsdom / 部分合成事件）
    if (
      event.button !== undefined
      && event.button !== 0
      && event.button !== 1
      && event.button !== 2
    ) {
      return;
    }
    const mapped = mapPoint(event);
    if (!mapped) return;
    event.preventDefault();
    event.currentTarget.focus();
    setStageFocused(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 部分环境不支持 capture，仍继续本地跟踪
    }
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
    gestureRef.current = {
      // jsdom 合成事件可能缺 pointerId；用 1 作为默认主指针
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : 1,
      startDisplay: mapped.display,
      startViewport: mapped.viewport,
      lastViewport: mapped.viewport,
      path: [],
      dragging: false,
      button,
    };
  }, [annotateMode, interactive, mapPoint]);

  const onStagePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const eventPointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (gesture.pointerId !== eventPointerId) return;
    if (annotateMode || !interactive) return;
    const mapped = mapPoint(event);
    if (!mapped) return;
    const dx = mapped.display.x - gesture.startDisplay.x;
    const dy = mapped.display.y - gesture.startDisplay.y;
    const distance = Math.hypot(dx, dy);
    if (!gesture.dragging && distance < BROWSER_STAGE_VIEWPORT.DRAG_THRESHOLD_PX) {
      return;
    }
    gesture.dragging = true;
    gesture.lastViewport = mapped.viewport;
    if (gesture.path.length < BROWSER_STAGE_VIEWPORT.DRAG_PATH_MAX_POINTS) {
      const last = gesture.path[gesture.path.length - 1];
      // 去抖：与上一点过近则跳过
      if (
        !last
        || Math.hypot(mapped.viewport.x - last.x, mapped.viewport.y - last.y) >= 1
      ) {
        gesture.path.push({ x: mapped.viewport.x, y: mapped.viewport.y });
      }
    }
  }, [annotateMode, interactive, mapPoint]);

  const finishPointerGesture = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    cancelled: boolean,
  ) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const eventPointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (gesture.pointerId !== eventPointerId) return;
    gestureRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(eventPointerId)) {
        event.currentTarget.releasePointerCapture(eventPointerId);
      }
    } catch {
      // ignore
    }
    if (annotateMode || !interactive || cancelled) return;
    suppressNextClickRef.current = true;

    if (gesture.dragging) {
      const mapped = mapPoint(event);
      const end = mapped?.viewport ?? gesture.lastViewport;
      route({
        kind: 'drag',
        fromX: gesture.startViewport.x,
        fromY: gesture.startViewport.y,
        toX: end.x,
        toY: end.y,
        button: gesture.button,
        ...(gesture.path.length > 0 ? { path: gesture.path } : {}),
      });
      return;
    }

    // 未达拖拽阈值 → 单击
    route({
      kind: 'click',
      x: gesture.startViewport.x,
      y: gesture.startViewport.y,
      button: gesture.button,
      clickCount: 1,
    });
  }, [annotateMode, interactive, mapPoint, route]);

  const onStagePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    finishPointerGesture(event, false);
  }, [finishPointerGesture]);

  const onStagePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    finishPointerGesture(event, true);
  }, [finishPointerGesture]);

  const onStageWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    if (annotateMode || !interactive) return;
    event.preventDefault();
    let x: number | undefined;
    let y: number | undefined;
    if (contentWidth && contentHeight) {
      const mapped = mapPoint(event);
      if (mapped) {
        x = mapped.viewport.x;
        y = mapped.viewport.y;
      }
    }
    route({
      kind: 'wheel',
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
    });
  }, [annotateMode, contentHeight, contentWidth, interactive, mapPoint, route]);

  const onStageKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (annotateMode) return;
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      setStageFocused(false);
      return;
    }
    if (!interactive) return;
    // IME 组合中：不逐键透传，等 compositionend 整段 insertText
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    // 可打印单字符：用 key 当 insertText 更稳（避免 keydown 重复）
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      route({ kind: 'insertText', text: event.key });
      return;
    }
    const allowed = new Set([
      'Enter', 'Tab', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown',
    ]);
    if (!allowed.has(event.key)) return;
    event.preventDefault();
    route({
      kind: 'key',
      key: event.key,
      modifiers: {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      },
    });
  }, [annotateMode, interactive, route]);

  const onStageCompositionEnd = useCallback((event: React.CompositionEvent<HTMLElement>) => {
    if (annotateMode || !interactive) return;
    const text = event.data;
    if (!text) return;
    route({ kind: 'insertText', text });
  }, [annotateMode, interactive, route]);

  const confirmPreempt = useCallback(() => {
    const pending = pendingPreemptInput;
    setPendingPreemptInput(null);
    setInteractionPreempted(true);
    preemptSurfaceRef.current = surfaceSessionId;
    if (pending) void send(pending);
  }, [pendingPreemptInput, send, surfaceSessionId]);

  const cancelPreempt = useCallback(() => {
    setPendingPreemptInput(null);
  }, []);

  return {
    stageFocused,
    setStageFocused,
    interactive: interactive && !annotateMode,
    pendingPreemptInput,
    confirmPreempt,
    cancelPreempt,
    onStageClick,
    onStagePointerDown,
    onStagePointerMove,
    onStagePointerUp,
    onStagePointerCancel,
    onStageWheel,
    onStageKeyDown,
    onStageCompositionEnd,
  };
}
