// ============================================================================
// composerScopeModel — composer 上下文分槽（会话 ⟂ 空间 ⟂ 草稿）
// ============================================================================
//
// 产品负责人 2026-08-05：会话 / 协作空间 / 主界面草稿是互不串扰的上下文。
// 槽里存「turn 选择 + 待挂载资源意图」；真正挂到会话上的 pin / 专家在发起会话时
// 才物化（setSessionPin / bindAgentForSession）。本文件只放纯函数与类型，
// 方便单测与 store 共用，不碰 React / IPC。
// ============================================================================

import type {
  BrowserSessionMode,
  ConversationRoutingMode,
  TurnCapabilityScopeMode,
} from '@shared/contract/conversationEnvelope';
import type { PendingCommandSelection } from '../components/features/chat/ChatInput/pendingCommand';

export const DRAFT_SCOPE_KEY = 'draft' as const;

export type ComposerScopeKey =
  | typeof DRAFT_SCOPE_KEY
  | `session:${string}`
  | `space:${string}`;

/** 单槽快照：可配置状态 + 尚无 sessionId 时的挂载意图。 */
export interface ComposerSlotSnapshot {
  workingDirectory: string | null;
  routingMode: ConversationRoutingMode;
  targetAgentIds: string[];
  browserSessionMode: BrowserSessionMode;
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  selectedMcpServerIds: string[];
  turnCapabilityScopeMode: TurnCapabilityScopeMode;
  selectedTeamRecipeId: string | null;
  standbyExcludedMemberKeys: string[];
  pendingCommand: PendingCommandSelection | null;
  /** 草稿/空间 pin 意图；会话槽通常为空（真源在 host getSessionPin）。 */
  pendingPinItemIds: string[];
  /** 草稿/空间专家意图；会话槽通常为空（真源在 activeAgentSessionMap）。 */
  pendingActiveAgentId: string | null;
}

export function sessionScopeKey(sessionId: string): ComposerScopeKey {
  return `session:${sessionId}`;
}

export function spaceScopeKey(projectId: string | null | undefined): ComposerScopeKey {
  const id = typeof projectId === 'string' && projectId.trim() ? projectId.trim() : 'none';
  return `space:${id}`;
}

export function isSessionScopeKey(key: ComposerScopeKey): key is `session:${string}` {
  return key.startsWith('session:');
}

export function isSpaceScopeKey(key: ComposerScopeKey): key is `space:${string}` {
  return key.startsWith('space:');
}

export function isDraftOrSpaceScopeKey(key: ComposerScopeKey): boolean {
  return key === DRAFT_SCOPE_KEY || isSpaceScopeKey(key);
}

export function sessionIdFromScopeKey(key: ComposerScopeKey): string | null {
  return isSessionScopeKey(key) ? key.slice('session:'.length) : null;
}

export function emptyComposerSlot(overrides?: Partial<ComposerSlotSnapshot>): ComposerSlotSnapshot {
  return {
    workingDirectory: null,
    routingMode: 'auto',
    targetAgentIds: [],
    browserSessionMode: 'none',
    selectedSkillIds: [],
    selectedConnectorIds: [],
    selectedMcpServerIds: [],
    turnCapabilityScopeMode: 'auto',
    selectedTeamRecipeId: null,
    standbyExcludedMemberKeys: [],
    pendingCommand: null,
    pendingPinItemIds: [],
    pendingActiveAgentId: null,
    ...overrides,
  };
}

/** 从 live composer 字段抽出快照（不含 activeScopeKey / slots 本身）。 */
export function snapshotComposerSlot(live: ComposerSlotSnapshot): ComposerSlotSnapshot {
  return {
    workingDirectory: live.workingDirectory,
    routingMode: live.routingMode,
    targetAgentIds: [...live.targetAgentIds],
    browserSessionMode: live.browserSessionMode,
    selectedSkillIds: [...live.selectedSkillIds],
    selectedConnectorIds: [...live.selectedConnectorIds],
    selectedMcpServerIds: [...live.selectedMcpServerIds],
    turnCapabilityScopeMode: live.turnCapabilityScopeMode,
    selectedTeamRecipeId: live.selectedTeamRecipeId,
    standbyExcludedMemberKeys: [...live.standbyExcludedMemberKeys],
    pendingCommand: live.pendingCommand ? { ...live.pendingCommand } : null,
    pendingPinItemIds: [...live.pendingPinItemIds],
    pendingActiveAgentId: live.pendingActiveAgentId,
  };
}

/**
 * 发起会话移交：源槽内容写入新会话槽；pin 意图保留在返回值供调用方 setSessionPin；
 * 源槽清空。专家 id 同样返回供 bindAgentForSession。
 */
export function planScopeHandoffToSession(args: {
  slots: Record<string, ComposerSlotSnapshot>;
  sourceKey: ComposerScopeKey;
  sourceLive: ComposerSlotSnapshot;
  newSessionId: string;
}): {
  nextSlots: Record<string, ComposerSlotSnapshot>;
  sessionKey: ComposerScopeKey;
  sessionSlot: ComposerSlotSnapshot;
  pinItemIds: string[];
  activeAgentId: string | null;
} {
  const sessionKey = sessionScopeKey(args.newSessionId);
  const sourceSnap = snapshotComposerSlot(args.sourceLive);
  const pinItemIds = [...sourceSnap.pendingPinItemIds];
  const activeAgentId = sourceSnap.pendingActiveAgentId;
  // 会话真源：pin 物化后 pending 清空；专家进 session map 后 pending 也清空
  const sessionSlot = emptyComposerSlot({
    ...sourceSnap,
    pendingPinItemIds: [],
    pendingActiveAgentId: null,
  });
  const nextSlots: Record<string, ComposerSlotSnapshot> = {
    ...args.slots,
    [args.sourceKey]: emptyComposerSlot(),
    [sessionKey]: sessionSlot,
  };
  return { nextSlots, sessionKey, sessionSlot, pinItemIds, activeAgentId };
}
