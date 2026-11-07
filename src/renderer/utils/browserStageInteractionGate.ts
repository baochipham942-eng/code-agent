// 画面交互透传门控：外会话禁、批注互斥、agent 忙首次确认（复用二期抢占语义）。
// 悬浮壳 UI（如人工接管条）不算页面内容：指针/点击不透传，见下方 overlay 判定。

/** stage 悬浮壳 UI 的标记属性，展开到壳 UI 根节点上。 */
const BROWSER_STAGE_OVERLAY_ATTRIBUTE = 'data-browser-stage-overlay';

/** 悬浮壳 UI 根节点的 JSX 标记，配合 isBrowserStageOverlayTarget 使用。 */
export const browserStageOverlayMarker: Record<string, string> = {
  [BROWSER_STAGE_OVERLAY_ATTRIBUTE]: '',
};

/** 事件目标是否落在 stage 悬浮壳 UI 内：壳上的指针起点/点击不透传到页面。 */
export function isBrowserStageOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest(`[${BROWSER_STAGE_OVERLAY_ATTRIBUTE}]`) !== null;
}

export type BrowserStageInteractionGateReason =
  | 'allowed'
  | 'foreign-session'
  | 'annotate-mode'
  | 'not-ready'
  | 'needs-preempt-confirm'
  | 'preempt-confirmed';

export interface BrowserStageInteractionGateInput {
  ownedByCurrentSession: boolean;
  annotateMode: boolean;
  /** 有实时画面 + 运行中 */
  ready: boolean;
  /** 本会话 agent surface 忙（非用户链接 run） */
  agentSurfaceBusy: boolean;
  /** 用户已对当前 agent 会话确认过抢占 */
  interactionPreempted: boolean;
}

export function resolveBrowserStageInteractionGate(
  input: BrowserStageInteractionGateInput,
): BrowserStageInteractionGateReason {
  if (!input.ownedByCurrentSession) return 'foreign-session';
  if (input.annotateMode) return 'annotate-mode';
  if (!input.ready) return 'not-ready';
  if (input.agentSurfaceBusy && !input.interactionPreempted) return 'needs-preempt-confirm';
  if (input.agentSurfaceBusy && input.interactionPreempted) return 'preempt-confirmed';
  return 'allowed';
}

export function shouldDispatchBrowserStageInteraction(
  reason: BrowserStageInteractionGateReason,
): boolean {
  return reason === 'allowed' || reason === 'preempt-confirmed';
}
