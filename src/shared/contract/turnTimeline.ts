import type {
  ConversationExecutionIntent,
  ConversationRoutingMode,
  TurnCapabilityScopeMode,
  WorkbenchMessageMetadata,
} from './conversationEnvelope';

export type TurnTimelineNodeKind =
  | 'workbench_snapshot'
  | 'capability_scope'
  | 'blocked_capabilities'
  | 'routing_evidence'
  | 'hook_activity'
  | 'skill_activity'
  | 'artifact_ownership';

export type TurnTimelineTone = 'neutral' | 'info' | 'warning' | 'success' | 'error';

export type BlockedCapabilityKind = 'skill' | 'connector' | 'mcp';

export type TurnCapabilityReadiness =
  | 'ready'
  | 'needs_config'
  | 'needs_permission'
  | 'offline'
  | 'unsupported'
  | 'blocked_high_risk';

export type BlockedCapabilityReasonCode =
  | 'skill_not_mounted'
  | 'skill_missing'
  | 'connector_disconnected'
  | 'connector_unverified'
  | 'connector_auth_failed'
  | 'mcp_disconnected'
  | 'mcp_error'
  | 'scope_empty'
  | 'reserved_browser_session_required'
  | 'reserved_desktop_permission_required';

export interface TurnWorkbenchSnapshot {
  workingDirectory?: string | null;
  routingMode?: ConversationRoutingMode;
  targetAgentIds?: string[];
  targetAgentNames?: string[];
  preferredAgentId?: string | null;
  preferredAgentName?: string | null;
  selectedAgent?: WorkbenchMessageMetadata['selectedAgent'];
  selectedPromptCommand?: WorkbenchMessageMetadata['selectedPromptCommand'];
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
  turnCapabilityScopeMode?: TurnCapabilityScopeMode;
  executionIntent?: ConversationExecutionIntent;
}

export interface BlockedCapabilityReason {
  kind: BlockedCapabilityKind;
  id: string;
  label: string;
  code: BlockedCapabilityReasonCode;
  detail: string;
  hint: string;
  severity: 'warning' | 'error';
}

export interface TurnCapabilityScopeItem {
  kind: BlockedCapabilityKind;
  id: string;
  label: string;
  readiness?: TurnCapabilityReadiness;
}

export interface TurnCapabilityInvocationAction {
  label: string;
  count: number;
}

export interface TurnCapabilityInvocationItem extends TurnCapabilityScopeItem {
  count: number;
  topActions: TurnCapabilityInvocationAction[];
}

export interface TurnCapabilityScope {
  mode: TurnCapabilityScopeMode;
  selected: TurnCapabilityScopeItem[];
  allowed: TurnCapabilityScopeItem[];
  blocked: BlockedCapabilityReason[];
  invoked: TurnCapabilityInvocationItem[];
}

export function createEmptyTurnCapabilityScope(
  mode: TurnCapabilityScopeMode = 'auto',
): TurnCapabilityScope {
  return {
    mode,
    selected: [],
    allowed: [],
    blocked: [],
    invoked: [],
  };
}

export type RoutingEvidenceStepStatus =
  | 'requested'
  | 'delivered'
  | 'missing'
  | 'resolved'
  | 'approved'
  | 'rejected'
  | 'started'
  | 'fallback';

interface TurnRoutingEvidenceStep {
  status: RoutingEvidenceStepStatus;
  label: string;
  detail?: string;
  tone: TurnTimelineTone;
  timestamp?: number;
}

export interface TurnRoutingEvidence {
  mode: ConversationRoutingMode;
  summary: string;
  agentIds?: string[];
  agentNames?: string[];
  reason?: string;
  score?: number;
  steps: TurnRoutingEvidenceStep[];
}

export interface TurnHookActivityItem {
  timestamp: number;
  event: string;
  action: 'allow' | 'block';
  hookCount: number;
  durationMs: number;
  sources: Array<'global' | 'project'>;
  hookType: 'decision' | 'observer';
  /** 触发的 hook 各自的名字。会话里只显示到这一层。 */
  names?: string[];
  modified?: boolean;
  errorCount?: number;
  // 这里刻意没有 message：hook 的 stdout 是任意内容（实测漏过整份记忆索引原文），
  // 渲染层拿不到它才是真正守得住的做法，加过滤守不住。要看原文去日志。
  /**
   * block/modify 的决策原因摘要（host 侧已首行截断 120 字 + 脱敏）。
   * 这是上面「message 不上屏」原则的唯一例外：单行、有界、可解释，不是原始输出。
   */
  reason?: string;
  toolName?: string;
  matcher?: string;
}

/** 正在执行的 hook 批次（hook_started 已到达、配对 hook_trigger 未到达）。 */
export interface TurnHookRunning {
  event: string;
  names?: string[];
}

export interface TurnHookActivity {
  summary: string;
  items: TurnHookActivityItem[];
  running?: TurnHookRunning;
}

export type TurnSkillActivityAction = 'selected' | 'triggered' | 'written';

export interface TurnSkillActivityItem {
  timestamp: number;
  skillId: string;
  label: string;
  action: TurnSkillActivityAction;
  detail?: string;
  source?: string;
}

export interface TurnSkillActivity {
  summary: string;
  items: TurnSkillActivityItem[];
}

export type TurnArtifactKind = 'file' | 'artifact' | 'link' | 'note';
export type TurnArtifactOwnerKind = 'assistant' | 'tool' | 'agent';

export interface TurnArtifactOwnershipItem {
  kind: TurnArtifactKind;
  label: string;
  ownerKind: TurnArtifactOwnerKind;
  ownerLabel: string;
  path?: string;
  url?: string;
  sourceNodeId?: string;
}

export interface TurnTimelineNode {
  id: string;
  kind: TurnTimelineNodeKind;
  timestamp: number;
  tone: TurnTimelineTone;
  snapshot?: TurnWorkbenchSnapshot;
  capabilityScope?: TurnCapabilityScope;
  blockedCapabilities?: BlockedCapabilityReason[];
  routingEvidence?: TurnRoutingEvidence;
  hookActivity?: TurnHookActivity;
  skillActivity?: TurnSkillActivity;
  artifactOwnership?: TurnArtifactOwnershipItem[];
}

export function snapshotFromWorkbenchMetadata(
  metadata?: WorkbenchMessageMetadata,
): TurnWorkbenchSnapshot | undefined {
  if (!metadata) {
    return undefined;
  }

  const snapshot: TurnWorkbenchSnapshot = {};

  if (metadata.workingDirectory !== undefined) {
    snapshot.workingDirectory = metadata.workingDirectory;
  }
  if (metadata.routingMode) {
    snapshot.routingMode = metadata.routingMode;
  }
  if (metadata.preferredAgentId !== undefined) {
    snapshot.preferredAgentId = metadata.preferredAgentId;
  }
  if (metadata.preferredAgentName !== undefined) {
    snapshot.preferredAgentName = metadata.preferredAgentName;
  }
  if (metadata.selectedAgent) {
    snapshot.selectedAgent = { ...metadata.selectedAgent };
  }
  if (metadata.selectedPromptCommand) {
    snapshot.selectedPromptCommand = {
      ...metadata.selectedPromptCommand,
      hints: metadata.selectedPromptCommand.hints ? [...metadata.selectedPromptCommand.hints] : undefined,
    };
  }
  if (metadata.targetAgentIds?.length) {
    snapshot.targetAgentIds = [...metadata.targetAgentIds];
  }
  if (metadata.targetAgentNames?.length) {
    snapshot.targetAgentNames = [...metadata.targetAgentNames];
  }
  if (metadata.selectedSkillIds?.length) {
    snapshot.selectedSkillIds = [...metadata.selectedSkillIds];
  }
  if (metadata.selectedConnectorIds?.length) {
    snapshot.selectedConnectorIds = [...metadata.selectedConnectorIds];
  }
  if (metadata.selectedMcpServerIds?.length) {
    snapshot.selectedMcpServerIds = [...metadata.selectedMcpServerIds];
  }
  if (metadata.turnCapabilityScopeMode) {
    snapshot.turnCapabilityScopeMode = metadata.turnCapabilityScopeMode;
  }
  if (metadata.executionIntent) {
    snapshot.executionIntent = {
      ...metadata.executionIntent,
    };
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}
