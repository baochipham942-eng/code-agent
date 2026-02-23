// ============================================================================
// Code Validator - Static safety checks for PTC code execution
// ============================================================================

import { createLogger } from '../../services/infra/logger';

const logger = createLogger('CodeValidator');

interface BlockedPattern {
  pattern: RegExp;
  msg: string;
}

/**
 * 禁止的代码模式
 * 阻止 require/import/process/eval 等危险操作
 */
const BLOCKED_PATTERNS: BlockedPattern[] = [
  { pattern: /\brequire\s*\(/, msg: 'require() not allowed' },
  { pattern: /\bimport\s*\(/, msg: 'dynamic import() not allowed' },
  { pattern: /\bimport\s+/, msg: 'import statement not allowed' },
  { pattern: /\bprocess\.exit/, msg: 'process.exit not allowed' },
  { pattern: /\bprocess\.env/, msg: 'process.env access not allowed' },
  { pattern: /\bchild_process\b/, msg: 'child_process not allowed' },
  { pattern: /\beval\s*\(/, msg: 'eval() not allowed' },
  { pattern: /\bFunction\s*\(/, msg: 'Function() constructor not allowed' },
  { pattern: /\b__proto__\b/, msg: '__proto__ access not allowed' },
  { pattern: /\bglobalThis\.process\b/, msg: 'globalThis.process not allowed' },
];

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 验证代码安全性
 * 静态分析代码，检查是否包含危险模式
 */
export function validateCodeSafety(code: string): ValidationResult {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Code must be a non-empty string' };
  }

  if (code.length > 50_000) {
    return { valid: false, error: 'Code too long (max 50KB)' };
  }

  for (const { pattern, msg } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      logger.warn('Code validation failed', { pattern: msg });
      return { valid: false, error: `Security violation: ${msg}` };
    }
  }

  return { valid: true };
}
