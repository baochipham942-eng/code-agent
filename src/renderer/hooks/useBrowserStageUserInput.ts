import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
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
  /** 实时帧内容尺寸（device CSS px） */
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
  onStageClick: (event: MouseEvent<HTMLElement>) => void;
  onStageWheel: (event: WheelEvent<HTMLElement>) => void;
  onStageKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onStageCompositionEnd: (event: React.CompositionEvent<HTMLElement>) => void;
}

/**
 * 画面交互透传：坐标映射 + 门控（外会话/批注/抢占）+ host dispatch。
 * 批注模式由调用方独占 onClick，本 hook 在 annotate 时 no-op。
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
    if (!conversationId || !workspace) return;
    try {
      await dispatchUserBrowserInput({
        conversationId,
        workspace,
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

  const mapClick = useCallback((event: MouseEvent<HTMLElement>): UserBrowserInputPayload | null => {
    if (!contentWidth || !contentHeight) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const mapped = mapDisplayPointToViewport(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: contentWidth, height: contentHeight },
    );
    if (!mapped) return null;
    const clickCount = event.detail >= 2 ? 2 : 1;
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
    return {
      kind: 'click',
      x: mapped.x,
      y: mapped.y,
      button,
      clickCount,
    };
  }, [contentHeight, contentWidth]);

  const onStageClick = useCallback((event: MouseEvent<HTMLElement>) => {
    if (annotateMode) return;
    // 右键留给系统菜单时仍可透传；preventDefault 避免选中拖影
    event.preventDefault();
    if (!interactive) return;
    event.currentTarget.focus();
    setStageFocused(true);
    const payload = mapClick(event);
    if (payload) route(payload);
  }, [annotateMode, interactive, mapClick, route]);

  const onStageWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    if (annotateMode || !interactive) return;
    event.preventDefault();
    let x: number | undefined;
    let y: number | undefined;
    if (contentWidth && contentHeight) {
      const rect = event.currentTarget.getBoundingClientRect();
      const mapped = mapDisplayPointToViewport(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
        { width: contentWidth, height: contentHeight },
      );
      if (mapped) {
        x = mapped.x;
        y = mapped.y;
      }
    }
    route({
      kind: 'wheel',
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
    });
  }, [annotateMode, contentHeight, contentWidth, interactive, route]);

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
    onStageWheel,
    onStageKeyDown,
    onStageCompositionEnd,
  };
}
