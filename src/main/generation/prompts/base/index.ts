// ============================================================================
// Base Prompts Index - Export all generation tool definitions
// ============================================================================

import type { GenerationId } from '../../../../shared/types';
import { GEN1_TOOLS } from './gen1';
import { GEN2_TOOLS } from './gen2';
import { GEN3_TOOLS } from './gen3';
import { GEN4_TOOLS } from './gen4';
import { GEN5_TOOLS } from './gen5';
import { GEN6_TOOLS } from './gen6';
import { GEN7_TOOLS } from './gen7';
import { GEN8_TOOLS } from './gen8';

export { GEN1_TOOLS } from './gen1';
export { GEN2_TOOLS } from './gen2';
export { GEN3_TOOLS } from './gen3';
export { GEN4_TOOLS } from './gen4';
export { GEN5_TOOLS } from './gen5';
export { GEN6_TOOLS } from './gen6';
export { GEN7_TOOLS } from './gen7';
export { GEN8_TOOLS } from './gen8';

export const BASE_PROMPTS: Record<GenerationId, string> = {
  gen1: GEN1_TOOLS,
  gen2: GEN2_TOOLS,
  gen3: GEN3_TOOLS,
  gen4: GEN4_TOOLS,
  gen5: GEN5_TOOLS,
  gen6: GEN6_TOOLS,
  gen7: GEN7_TOOLS,
  gen8: GEN8_TOOLS,
};
