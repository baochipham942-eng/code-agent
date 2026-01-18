// ============================================================================
// Base Prompts Index - Export all generation base prompts
// ============================================================================

export { GEN1_BASE_PROMPT } from './gen1';
export { GEN2_BASE_PROMPT } from './gen2';
export { GEN3_BASE_PROMPT } from './gen3';
export { GEN4_BASE_PROMPT } from './gen4';
export { GEN5_BASE_PROMPT } from './gen5';
export { GEN6_BASE_PROMPT } from './gen6';
export { GEN7_BASE_PROMPT } from './gen7';
export { GEN8_BASE_PROMPT } from './gen8';

import type { GenerationId } from '../../../../shared/types';
import { GEN1_BASE_PROMPT } from './gen1';
import { GEN2_BASE_PROMPT } from './gen2';
import { GEN3_BASE_PROMPT } from './gen3';
import { GEN4_BASE_PROMPT } from './gen4';
import { GEN5_BASE_PROMPT } from './gen5';
import { GEN6_BASE_PROMPT } from './gen6';
import { GEN7_BASE_PROMPT } from './gen7';
import { GEN8_BASE_PROMPT } from './gen8';

export const BASE_PROMPTS: Record<GenerationId, string> = {
  gen1: GEN1_BASE_PROMPT,
  gen2: GEN2_BASE_PROMPT,
  gen3: GEN3_BASE_PROMPT,
  gen4: GEN4_BASE_PROMPT,
  gen5: GEN5_BASE_PROMPT,
  gen6: GEN6_BASE_PROMPT,
  gen7: GEN7_BASE_PROMPT,
  gen8: GEN8_BASE_PROMPT,
};
