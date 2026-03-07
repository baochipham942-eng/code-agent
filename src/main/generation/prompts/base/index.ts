// ============================================================================
// Base Prompts Index - Only gen8 retained (Sprint 2: removed gen1-gen7)
// ============================================================================

import type { GenerationId } from '../../../../shared/types';
import { GEN8_TOOLS } from './gen8';

export { GEN8_TOOLS } from './gen8';

/** Only gen8 prompt */
export const BASE_PROMPTS: Partial<Record<GenerationId, string>> = {
  gen8: GEN8_TOOLS,
};
