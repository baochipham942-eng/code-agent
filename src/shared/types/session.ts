// ============================================================================
// Session Types
// ============================================================================

import type { GenerationId } from './generation';
import type { ModelConfig } from './model';

export interface Session {
  id: string;
  title: string;
  generationId: GenerationId;
  modelConfig: ModelConfig;
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
}
