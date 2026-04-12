// ============================================================================
// Context Observability Types - shared structures for context diagnostics
// ============================================================================

export type ContextInterventionStatus = 'neutral' | 'pinned' | 'excluded' | 'retained';

export interface ContextInterventionItem {
  id: string;
  label: string;
  sourceType: 'message' | 'tool' | 'attachment' | 'memory';
  sourceDetail: string;
  reason: string;
  tokens: number;
  status: ContextInterventionStatus;
  addedBy?: string;
  timestamp: number;
}

export type ContextProvenanceAction = 'added' | 'retrieved' | 'compressed' | 'pinned' | 'excluded' | 'retained';

export interface ContextProvenanceEntry {
  id: string;
  label: string;
  source: string;
  sourceType: 'message' | 'tool' | 'attachment' | 'memory';
  reason: string;
  tokens: number;
  action: ContextProvenanceAction;
  agentId?: string;
  timestamp: number;
}

export interface ContextViewData {
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
  apiViewPreview: Array<{
    id: string;
    role: string;
    contentPreview: string;
    tokens: number;
  }>;
  recentCommits: Array<{
    layer: string;
    operation: string;
    timestamp: number;
    targetCount: number;
  }>;
  interventionItems?: ContextInterventionItem[];
  provenanceEntries?: ContextProvenanceEntry[];
}
