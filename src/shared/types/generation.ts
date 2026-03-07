// ============================================================================
// Generation Types
// ============================================================================
// Sprint 2: gen8 is the only active generation. GenerationId union kept wide
// for backward compatibility while other code is being cleaned up.

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

/** @deprecated Sprint 2: no longer needed, kept for type compatibility */
export interface GenerationDiff {
  added: string[];
  removed: string[];
  modified: Array<{
    line: number;
    before: string;
    after: string;
  }>;
}
