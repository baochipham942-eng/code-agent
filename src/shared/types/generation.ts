// ============================================================================
// Generation Types
// ============================================================================

export type GenerationId = 'gen1' | 'gen2' | 'gen3' | 'gen4' | 'gen5' | 'gen6' | 'gen7' | 'gen8';

export interface Generation {
  id: GenerationId;
  name: string;
  version: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  promptMetadata: {
    lineCount: number;
    toolCount: number;
    ruleCount: number;
  };
}

export interface GenerationDiff {
  added: string[];
  removed: string[];
  modified: Array<{
    line: number;
    before: string;
    after: string;
  }>;
}
