// ============================================================================
// Base Prompts Index - Export all generation tool definitions
// ============================================================================

// 导出新的工具定义
export { GEN1_TOOLS, GEN1_BASE_PROMPT } from './gen1';
export { GEN2_TOOLS, GEN2_BASE_PROMPT } from './gen2';
export { GEN3_TOOLS, GEN3_BASE_PROMPT } from './gen3';
export { GEN4_TOOLS, GEN4_BASE_PROMPT } from './gen4';
export { GEN5_TOOLS, GEN5_BASE_PROMPT } from './gen5';
export { GEN6_TOOLS, GEN6_BASE_PROMPT } from './gen6';
export { GEN7_TOOLS, GEN7_BASE_PROMPT } from './gen7';
export { GEN8_TOOLS, GEN8_BASE_PROMPT } from './gen8';

import type { GenerationId } from '../../../../shared/types';
import { GEN1_TOOLS } from './gen1';
import { GEN2_TOOLS } from './gen2';
import { GEN3_TOOLS } from './gen3';
import { GEN4_TOOLS } from './gen4';
import { GEN5_TOOLS } from './gen5';
import { GEN6_TOOLS } from './gen6';
import { GEN7_TOOLS } from './gen7';
import { GEN8_TOOLS } from './gen8';

// 新的工具定义映射（推荐使用）
export const GENERATION_TOOLS: Record<GenerationId, string> = {
  gen1: GEN1_TOOLS,
  gen2: GEN2_TOOLS,
  gen3: GEN3_TOOLS,
  gen4: GEN4_TOOLS,
  gen5: GEN5_TOOLS,
  gen6: GEN6_TOOLS,
  gen7: GEN7_TOOLS,
  gen8: GEN8_TOOLS,
};

// 向后兼容的别名
export const BASE_PROMPTS = GENERATION_TOOLS;
