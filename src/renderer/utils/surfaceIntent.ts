import type { Message } from '@shared/contract';

export type SurfaceArtifact =
  | { kind: 'workspace-preview'; itemId: string }
  | { kind: 'file-preview'; filePath: string }
  | { kind: 'design-canvas' }
  | { kind: 'swarm-monitor' };

export type SurfaceIntentView =
  | 'workspace-preview'
  | 'file-preview'
  | 'design-canvas'
  | 'task-monitor'
  | 'other';

export type SurfaceIntentDecision =
  | { view: 'workspace-preview'; itemId: string }
  | { view: 'file-preview'; filePath: string }
  | { view: 'design-canvas' }
  | { view: 'task-monitor' };

export interface SurfaceIntentInput {
  artifact: SurfaceArtifact;
  artifactSessionId?: string;
  currentSessionId: string | null | undefined;
  hasAutoFocusedThisTurn: boolean;
  userSwitchedAwayThisTurn: boolean;
}

/**
 * 产物到右栏视图的唯一产品决策点。
 *
 * 带 sessionId 的产物必须精确属于前台会话；同一轮只允许首个产物抢焦点，
 * 用户手动切走后也不再抢回。调用方只负责保存轮次状态和执行这里返回的视图动作。
 */
export function decideSurfaceIntent(input: SurfaceIntentInput): SurfaceIntentDecision | null {
  if (input.artifactSessionId && input.artifactSessionId !== input.currentSessionId) {
    return null;
  }
  if (input.hasAutoFocusedThisTurn || input.userSwitchedAwayThisTurn) {
    return null;
  }

  switch (input.artifact.kind) {
    case 'workspace-preview':
      return { view: 'workspace-preview', itemId: input.artifact.itemId };
    case 'file-preview':
      return { view: 'file-preview', filePath: input.artifact.filePath };
    case 'design-canvas':
      return { view: 'design-canvas' };
    case 'swarm-monitor':
      return { view: 'task-monitor' };
  }
}

/**
 * 与 useTurnProjection 的轮次边界保持一致：普通 user message 开新轮，
 * 运行中的 supplement 仍属于当前轮。
 */
export function deriveSurfaceIntentTurnId(messages: Message[]): string {
  let turnId = 'bootstrap';
  for (const message of messages) {
    if (message.role !== 'user' || message.isMeta) continue;
    const workbench = message.metadata?.workbench;
    const isCurrentTurnSupplement = workbench?.runtimeInputMode === 'supplement'
      && workbench.runtimeInputDelivery !== 'queued_next_turn';
    if (isCurrentTurnSupplement) continue;
    turnId = message.metadata?.neoTag?.sourceTurnId || message.id;
  }
  return turnId;
}

export function surfaceIntentViewForWorkbenchTab(tabId: string | null): SurfaceIntentView {
  if (tabId === 'workspace-preview') return 'workspace-preview';
  if (tabId?.startsWith('preview:')) return 'file-preview';
  if (tabId === 'design-canvas') return 'design-canvas';
  if (tabId === 'task') return 'task-monitor';
  return 'other';
}

interface PreviewArtifactCandidate {
  id: string;
  currentTurn?: boolean;
  source: { turnNumber?: number };
}

export function findNewCurrentTurnPreviewArtifacts<T extends PreviewArtifactCandidate>(
  items: T[],
  turnNumber: number | undefined,
  observedIds: ReadonlySet<string>,
): { newItems: T[]; observedIds: Set<string> } {
  if (turnNumber === undefined) {
    return { newItems: [], observedIds: new Set(observedIds) };
  }
  const currentItems = items.filter((item) => (
    item.currentTurn === true && item.source.turnNumber === turnNumber
  ));
  return {
    newItems: currentItems.filter((item) => !observedIds.has(item.id)),
    observedIds: new Set([
      ...observedIds,
      ...currentItems.map((item) => item.id),
    ]),
  };
}
