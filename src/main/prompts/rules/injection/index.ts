// ============================================================================
// Injection Defense - Index
// 注入防护规则的统一导出
// ============================================================================

export { INJECTION_CORE_RULES } from './core';
export { INJECTION_VERIFICATION_RULES } from './verification';
export { INJECTION_META_RULES } from './meta';

/**
 * 完整的注入防护规则集
 *
 * 组合三层防护：
 * 1. 核心层 - 指令来源验证
 * 2. 验证层 - 可疑内容识别和处理
 * 3. 元规则层 - 规则不可修改性
 */
import { INJECTION_CORE_RULES } from './core';
import { INJECTION_VERIFICATION_RULES } from './verification';
import { INJECTION_META_RULES } from './meta';

export const INJECTION_DEFENSE_RULES = [
  INJECTION_CORE_RULES,
  INJECTION_VERIFICATION_RULES,
  INJECTION_META_RULES,
].join('\n\n');
