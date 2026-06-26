// ============================================================================
// Input Sanitizer - 外部数据源安全校验
// ============================================================================
//
// 检测外部数据（web_fetch/MCP/read_xlsx 等）中的 prompt injection。
// 轻量无状态，AgentLoop 直接持有。

import { createLogger } from '../services/infra/logger';
import { INJECTION_PATTERNS, type InjectionPattern } from './patterns/injectionPatterns';
import { getSensitiveDetector } from './sensitiveDetector';

const logger = createLogger('InputSanitizer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SanitizationWarning {
  type: 'prompt_injection' | 'jailbreak_attempt' | 'data_exfiltration' | 'instruction_override' | 'sensitive_data';
  severity: 'low' | 'medium' | 'high' | 'critical';
  pattern: string;
  description: string;
}

export interface SanitizationResult {
  safe: boolean;
  sanitized: string;
  warnings: SanitizationWarning[];
  blocked: boolean;
  riskScore: number; // 0-1
}

export type SanitizationMode = 'strict' | 'moderate' | 'permissive';

export interface SanitizationConfig {
  mode: SanitizationMode;
  /** critical 风险直接阻断 */
  blockOnCritical: boolean;
  /** high 风险的最大容忍次数（同一次 sanitize 调用中） */
  maxHighWarnings: number;
  /** 自定义模式 */
  customPatterns: InjectionPattern[];
}

const DEFAULT_CONFIG: SanitizationConfig = {
  mode: 'moderate',
  blockOnCritical: true,
  maxHighWarnings: 3,
  customPatterns: [],
};

// 风险权重
const SEVERITY_WEIGHTS: Record<SanitizationWarning['severity'], number> = {
  low: 0.1,
  medium: 0.25,
  high: 0.5,
  critical: 1.0,
};

// mode 对应的阻断阈值
const MODE_THRESHOLDS: Record<SanitizationMode, number> = {
  strict: 0.3,
  moderate: 0.6,
  permissive: 0.9,
};

// ----------------------------------------------------------------------------
// Input Sanitizer
// ----------------------------------------------------------------------------

export class InputSanitizer {
  private config: SanitizationConfig;
  private allPatterns: InjectionPattern[];

  constructor(config?: Partial<SanitizationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.allPatterns = [...INJECTION_PATTERNS, ...this.config.customPatterns];
  }

  /**
   * 扫描输入内容，检测 prompt injection 和其他安全风险
   *
   * @param input - 外部数据内容
   * @param source - 数据来源工具名（如 'web_fetch', 'mcp'）
   */
  sanitize(input: string, source: string): SanitizationResult {
    if (!input || input.length === 0) {
      return { safe: true, sanitized: input, warnings: [], blocked: false, riskScore: 0 };
    }

    const warnings: SanitizationWarning[] = [];

    // 1. 检测 prompt injection 模式
    for (const { pattern, type, severity, description } of this.allPatterns) {
      // 重置 lastIndex（全局正则）
      pattern.lastIndex = 0;

      if (pattern.test(input)) {
        warnings.push({
          type,
          severity,
          pattern: pattern.source.substring(0, 80),
          description,
        });
      }
    }

    // 2. 复用 SensitiveDetector 检测泄露的凭证
    const sensitiveDetector = getSensitiveDetector();
    const sensitiveResult = sensitiveDetector.detect(input);
    if (sensitiveResult.hasSensitive) {
      for (const match of sensitiveResult.matches) {
        if (match.confidence === 'high' || match.confidence === 'medium') {
          warnings.push({
            type: 'sensitive_data',
            severity: match.confidence === 'high' ? 'medium' : 'low',
            pattern: match.type,
            description: `外部数据包含 ${match.type}: ${match.masked}`,
          });
        }
      }
    }

    // 3. 计算风险分数
    const riskScore = this.calculateRiskScore(warnings);

    // 4. 判断是否阻断
    const threshold = MODE_THRESHOLDS[this.config.mode];
    const hasCritical = warnings.some(w => w.severity === 'critical');
    const highCount = warnings.filter(w => w.severity === 'high').length;

    const blocked =
      (this.config.blockOnCritical && hasCritical) ||
      (highCount > this.config.maxHighWarnings) ||
      (riskScore >= threshold);

    const safe = warnings.length === 0;

    if (warnings.length > 0) {
      logger.warn('InputSanitizer detected risks', {
        source,
        warningCount: warnings.length,
        riskScore: riskScore.toFixed(2),
        blocked,
        types: [...new Set(warnings.map(w => w.type))],
      });
    }

    return {
      safe,
      sanitized: input, // 不修改原始内容，只报告
      warnings,
      blocked,
      riskScore,
    };
  }

  /**
   * 添加自定义检测模式
   */
  addPattern(pattern: RegExp, type: SanitizationWarning['type'], severity: SanitizationWarning['severity'], description: string): void {
    this.allPatterns.push({ pattern, type, severity, description });
  }

  /**
   * 计算综合风险分数 (0-1)
   */
  private calculateRiskScore(warnings: SanitizationWarning[]): number {
    if (warnings.length === 0) return 0;

    let totalWeight = 0;
    for (const warning of warnings) {
      totalWeight += SEVERITY_WEIGHTS[warning.severity];
    }

    // 归一化到 0-1，使用 sigmoid-like 函数
    return Math.min(1, totalWeight / 2);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: InputSanitizer | null = null;

export function getInputSanitizer(config?: Partial<SanitizationConfig>): InputSanitizer {
  if (!instance) {
    instance = new InputSanitizer(config);
  }
  return instance;
}

export function resetInputSanitizer(): void {
  instance = null;
}
