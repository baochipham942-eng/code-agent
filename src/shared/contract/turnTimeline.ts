import type {
  ConversationExecutionIntent,
  ConversationRoutingMode,
  WorkbenchMessageMetadata,
} from './conversationEnvelope';

export type TurnTimelineNodeKind =
  | 'workbench_snapshot'
  | 'capability_scope'
  | 'blocked_capabilities'
  | 'routing_evidence'
  | 'artifact_ownership';

export type TurnTimelineTone = 'neutral' | 'info' | 'warning' | 'success' | 'error';

export type BlockedCapabilityKind = 'skill' | 'connector' | 'mcp';

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
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
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
  selected: TurnCapabilityScopeItem[];
  allowed: TurnCapabilityScopeItem[];
  blocked: BlockedCapabilityReason[];
  invoked: TurnCapabilityInvocationItem[];
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

export interface TurnRoutingEvidenceStep {
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
  if (metadata.executionIntent) {
    snapshot.executionIntent = {
      ...metadata.executionIntent,
    };
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}
