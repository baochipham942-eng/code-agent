// ============================================================================
// Context View Types - shared observability + manual selection model
// ============================================================================

export type ContextSelectionMode = 'default' | 'pinned' | 'excluded' | 'retained';

export type ContextSourceType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'attachment';

export interface ContextItemProvenance {
  sourceType: ContextSourceType;
  reasons: string[];
  categories?: ContextProvenanceCategory[];
  sourceDetail?: string;
  attachmentNames: string[];
  toolNames: string[];
}

export interface ContextItemView {
  id: string;
  role: string;
  contentPreview: string;
  tokens: number;
  included: boolean;
  selection: ContextSelectionMode;
  provenance: ContextItemProvenance;
}

export interface ContextViewRequest {
  sessionId: string;
  agentId?: string;
}

export interface ContextSelectionUpdateRequest {
  sessionId: string;
  itemId: string;
  selection: ContextSelectionMode;
  agentId?: string;
}

export interface ContextSelectionEntry {
  itemId: string;
  selection: Exclude<ContextSelectionMode, 'default'>;
  updatedAt: number;
}

export interface ContextSelectionState {
  sessionId: string;
  agentId?: string;
  entries: ContextSelectionEntry[];
}

export type ContextInterventionStatus = 'neutral' | 'pinned' | 'excluded' | 'retained';

export interface ContextInterventionItem {
  id: string;
  label: string;
  sourceType: 'message' | 'tool' | 'attachment' | 'memory' | 'file';
  sourceDetail: string;
  reason: string;
  tokens: number;
  status: ContextInterventionStatus;
  addedBy?: string;
  timestamp: number;
}

export type ContextProvenanceAction =
  | 'added'
  | 'retrieved'
  | 'compressed'
  | 'pinned'
  | 'excluded'
  | 'retained';

export type ContextProvenanceCategory =
  | 'recent_turn'
  | 'tool_result'
  | 'attachment'
  | 'dependency_carry_over'
  | 'manual_pin_retain'
  | 'compression_survivor'
  | 'excluded'
  | 'system_anchor'
  | 'unknown';

export interface ContextProvenanceListEntry {
  id: string;
  label: string;
  source: string;
  sourceType: 'message' | 'tool' | 'attachment' | 'memory' | 'file';
  reason: string;
  tokens: number;
  action: ContextProvenanceAction;
  category?: ContextProvenanceCategory;
  agentId?: string;
  timestamp: number;
}

export interface ContextViewResponse {
  sessionId?: string;
  agentId?: string;
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
  messageCount: number;
  tokenDistribution: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  compressionStatus: {
    layersTriggered: string[];
    totalCommits: number;
    snippedCount: number;
    collapsedSpans: number;
    savedTokens: number;
  };
  apiViewPreview: {
    id: string;
    role: string;
    contentPreview: string;
    tokens: number;
  }[];
  recentCommits: {
    layer: string;
    operation: string;
    timestamp: number;
    targetCount: number;
  }[];
  contextItems: ContextItemView[];
  selections: ContextSelectionState;
  provenance: ContextProvenanceEntry[];
  interventions: ContextInterventionSnapshot;
  rawInterventions?: ContextInterventionSnapshot;
  effectiveInterventions?: ContextInterventionSnapshot;
  interventionItems?: ContextInterventionItem[];
  provenanceEntries?: ContextProvenanceListEntry[];
}

export type ContextInterventionAction = 'pin' | 'exclude' | 'retain';

export interface ContextInterventionSnapshot {
  pinned: string[];
  excluded: string[];
  retained: string[];
}

export interface ContextInterventionRequest {
  sessionId?: string;
  agentId?: string;
}

export interface ContextInterventionSetRequest extends ContextInterventionRequest {
  messageId: string;
  action: ContextInterventionAction;
  enabled: boolean;
}

export type ContextProvenanceSource = 'system' | 'user' | 'assistant' | 'tool';

export type ContextModificationType =
  | 'collapsed'
  | 'snipped'
  | 'truncated'
  | 'microcompact'
  | 'pinned'
  | 'excluded'
  | 'retained';

export interface ContextProvenanceEntry {
  messageId: string;
  source: ContextProvenanceSource;
  reason: string;
  modifications: ContextModificationType[];
  category?: ContextProvenanceCategory;
  agentId?: string;
  layer?: string;
  timestamp?: number;
}
