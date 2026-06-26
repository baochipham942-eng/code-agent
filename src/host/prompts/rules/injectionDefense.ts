// ============================================================================
// Injection Defense Rules - 注入防护规则
// Re-exports from the split injection/ directory
// ============================================================================

/**
 * 注入防护规则（向后兼容导出）
 *
 * 规则已拆分为三个独立模块：
 * - injection/core.ts - 核心指令验证规则
 * - injection/verification.ts - 验证响应规则
 * - injection/meta.ts - 元规则（规则不可修改性）
 *
 * 此文件保留用于向后兼容
 */
export {
  INJECTION_DEFENSE_RULES,
  INJECTION_CORE_RULES,
  INJECTION_VERIFICATION_RULES,
  INJECTION_META_RULES,
} from './injection';
