// ============================================================================
// Prompt Stack Contract
// ============================================================================

export type PromptStackLayerId =
  | 'substrate'
  | 'dynamic'
  | 'soul'
  | 'tools'
  | 'tool-envelope'
  | 'remote-fragments'
  | 'role-assets'
  | 'project-profile'
  | 'skills'
  | 'unknown';

export interface PromptStackLayerSummary {
  id: PromptStackLayerId;
  label: string;
  present: boolean;
  chars: number;
  tokens: number;
  note?: string;
}

export interface PromptStackSummary {
  promptVersion: string;
  totalChars: number;
  totalTokens: number;
  hasDynamicBoundary: boolean;
  layers: PromptStackLayerSummary[];
  detectedCapabilities: string[];
  warnings: string[];
}
