// ============================================================================
// Prompt Stack Contract
// ============================================================================

import type { PromptLayerOutcome } from './contextView';

export type PromptStackLayerId = string;

export interface PromptStackSummaryRequest {
  sessionId: string;
  agentId?: string;
  invocationId?: string;
}

export interface PromptStackLayerSummary {
  id: PromptStackLayerId;
  label: string;
  present: boolean;
  chars: number;
  tokens: number;
  outcome: PromptLayerOutcome;
  note?: string;
}

export interface PromptStackToolSnapshot {
  names: string[];
  count: number;
  schemaHash: string;
}

export interface PromptStackModelBinding {
  model: string;
  provider: string;
}

export interface PromptStackCompactionCheckpoint {
  messageId?: string;
  timestamp: number;
  layer?: string;
  operation?: string;
}

export interface PromptStackSummary {
  sessionId?: string;
  agentId?: string;
  invocationId?: string;
  recordedAt?: number;
  promptVersion: string;
  totalChars: number;
  totalTokens: number;
  layers: PromptStackLayerSummary[];
  activeTools?: PromptStackToolSnapshot;
  modelBinding?: PromptStackModelBinding;
  compactionCheckpoint?: PromptStackCompactionCheckpoint;
  warnings: string[];
}
