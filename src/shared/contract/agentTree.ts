import type { AgentFailureCode } from './agentFailure';
import type { EvidenceRef } from './evidence';

export type AgentTreeNodeStatus =
  | 'queued'
  | 'running'
  | 'running-recovered'
  | 'dead-log-only'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'killed'
  | 'blocked'
  | 'unknown';

export type AgentTreeNodeSource =
  | 'spawnGuard'
  | 'parallelCoordinator'
  | 'subagentContext'
  | 'backgroundRegistry'
  | 'agentWorktree';

export interface AgentTreeEventSummary {
  summary: string;
  at?: number;
  source: AgentTreeNodeSource;
}

export interface AgentTreeBudgetSummary {
  costUsd?: number;
  tokensUsed?: number;
  maxTokens?: number;
  usagePercent?: number;
  iterations?: number;
  toolCalls?: number;
}

export type AgentTreeWorktreeStatus =
  | 'none'
  | 'active'
  | 'preserved'
  | 'cleaned'
  | 'error'
  | 'unknown';

export interface AgentTreeChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown';
}

export interface AgentTreeWorktreeState {
  status: AgentTreeWorktreeStatus;
  path?: string;
  branch?: string;
  changedFiles?: AgentTreeChangedFile[];
  diffSummary?: string;
  evidenceRefs?: EvidenceRef[];
}

export interface AgentWorktreeArtifact extends AgentTreeWorktreeState {
  agentId: string;
  repoPath?: string;
  updatedAt: number;
  error?: string;
}

export interface AgentWorktreeReviewRequest {
  agentId: string;
}

export interface AgentWorktreeReview extends AgentWorktreeArtifact {
  diff?: string;
  truncated?: boolean;
}

export interface AgentTreeNode {
  id: string;
  role: string;
  status: AgentTreeNodeStatus;
  statusLabel: string;
  parentId?: string;
  children: AgentTreeNode[];
  task?: string;
  progress?: string;
  lastEvent?: AgentTreeEventSummary;
  activeTool?: string;
  failureCode?: AgentFailureCode;
  failureReason?: string;
  worktreeState: AgentTreeWorktreeState;
  budgetSummary: AgentTreeBudgetSummary;
  evidenceRefs: EvidenceRef[];
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  sources: AgentTreeNodeSource[];
}

export interface AgentTreeSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  blocked: number;
  withWorktree: number;
  totalCostUsd?: number;
  totalTokensUsed?: number;
}

export interface AgentTreeSnapshot {
  generatedAt: number;
  sessionId?: string;
  roots: AgentTreeNode[];
  nodes: AgentTreeNode[];
  summary: AgentTreeSummary;
}

export interface AgentTreeRequest {
  sessionId?: string;
}
