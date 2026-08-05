// 画面交互透传门控：外会话禁、批注互斥、agent 忙首次确认（复用二期抢占语义）。

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
