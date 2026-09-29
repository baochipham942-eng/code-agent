// ============================================================================
// Input Sanitizer - 外部数据源安全校验
// ============================================================================
//
// 检测外部数据（web_fetch/MCP/read_xlsx 等）中的 prompt injection。
// 轻量无状态，AgentLoop 直接持有。

import { createLogger } from '../services/infra/logger';
import {
  INJECTION_PATTERNS,
  patternAppliesToScope,
  type InjectionAttackCategory,
  type InjectionPattern,
  type InjectionPatternScope,
} from './patterns/injectionPatterns';
import { getSensitiveDetector, type SensitiveMatch } from './sensitiveDetector';
import { ZERO_WIDTH_CHARACTERS } from './canonicalizeCommand';
import {
  foundRoleDelimiterTokens,
  generateBoundaryNonce,
  stripBoundaryNonce,
  stripSpecialTokenLiterals,
} from './untrustedContentBoundary';

const logger = createLogger('InputSanitizer');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SanitizationWarning {
  type: InjectionAttackCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  pattern: string;
  description: string;
}

export interface SanitizeOptions {
  /** Tool results default to lenient; memory writes and skill install use strict. */
  scope?: InjectionPatternScope;
  /** Test seam: supply a known nonce instead of generating one. */
  nonce?: string;
}

export interface SanitizationResult {
  safe: boolean;
  sanitized: string;
  warnings: SanitizationWarning[];
  blocked: boolean;
  riskScore: number; // 0-1
  /** Unforgeable boundary token for this sanitize call. Empty when input is empty. */
  nonce: string;
  strippedSpecialTokens: string[];
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

function foldScanText(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH_CHARACTERS, '');
}

function isReportableSecret(match: SensitiveMatch): boolean {
  return match.confidence === 'high' || match.confidence === 'medium';
}

function sensitiveDataWarning(match: SensitiveMatch): SanitizationWarning {
  return {
    type: 'sensitive_data',
    severity: match.confidence === 'high' ? 'medium' : 'low',
    pattern: match.type,
    description: `外部数据包含 ${match.type}: ${match.masked}`,
  };
}

// 折叠副本上的命中已经过 NFKC 和去零宽，键里不再折一次。
function sensitiveOccurrenceKey(match: SensitiveMatch, alreadyFolded: boolean): string {
  const value = alreadyFolded ? match.original : foldScanText(match.original);
  return `${match.type}:${value}:${match.confidence}`;
}

// 原文每一次出现都保留。折叠副本只补同一密钥多出来的次数
// （max(0, foldedCount - rawCount)）。按 type+归一化值+置信度收成一条
// 会把重复密钥的风险分从 0.625 降到 0.125，moderate 拦截被放掉。
function appendSensitiveDataWarnings(
  warnings: SanitizationWarning[],
  sanitized: string,
  scanText: string,
  textWasFolded: boolean,
): void {
  const detector = getSensitiveDetector();
  const rawCounts = new Map<string, number>();
  for (const match of detector.detect(sanitized).matches) {
    if (!isReportableSecret(match)) continue;
    warnings.push(sensitiveDataWarning(match));
    if (!textWasFolded) continue;
    const key = sensitiveOccurrenceKey(match, false);
    rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
  }
  if (!textWasFolded) return;

  const foldedCounts = new Map<string, { count: number; sample: SensitiveMatch }>();
  for (const match of detector.detect(scanText).matches) {
    if (!isReportableSecret(match)) continue;
    const key = sensitiveOccurrenceKey(match, true);
    const existing = foldedCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      foldedCounts.set(key, { count: 1, sample: match });
    }
  }
  for (const [key, folded] of foldedCounts) {
    const extra = Math.max(0, folded.count - (rawCounts.get(key) ?? 0));
    for (let copy = 0; copy < extra; copy += 1) {
      warnings.push(sensitiveDataWarning(folded.sample));
    }
  }
}

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
   * 扫描输入内容，检测 prompt injection 和其他安全风险。
   * 先无条件剥离模型控制 token 与本轮 nonce，再跑 block/annotate 检测。
   *
   * @param input - 外部数据内容
   * @param source - 数据来源工具名（如 'web_fetch', 'mcp'）
   */
  sanitize(input: string, source: string, options?: SanitizeOptions): SanitizationResult {
    if (!input || input.length === 0) {
      return {
        safe: true,
        sanitized: input,
        warnings: [],
        blocked: false,
        riskScore: 0,
        nonce: '',
        strippedSpecialTokens: [],
      };
    }

    const scope: InjectionPatternScope = options?.scope ?? 'lenient';
    const nonce = options?.nonce ?? generateBoundaryNonce();
    const { text: withoutSpecialTokens, found: strippedSpecialTokens } = stripSpecialTokenLiterals(input);
    const sanitized = stripBoundaryNonce(withoutSpecialTokens, nonce);
    // 扫描副本只用于匹配。返回的 sanitized 仍是剥离控制 token 后的原文。
    const scanText = foldScanText(sanitized);
    const textWasFolded = scanText !== sanitized;

    const warnings: SanitizationWarning[] = [];

    if (foundRoleDelimiterTokens(strippedSpecialTokens)) {
      warnings.push({
        type: 'instruction_override',
        severity: 'critical',
        pattern: 'llm-special-token',
        description: '使用已知的系统标记格式注入指令',
      });
    }

    // 1. 检测 prompt injection 模式（scope 过滤后，在剥离后的文本上跑）
    let unicodeObfuscationDetected = false;
    for (const item of this.allPatterns) {
      if (!patternAppliesToScope(item, scope)) continue;
      const { pattern, type, severity, description } = item;
      // 原文没有被折叠时，第二遍与第一遍相同，跳过。
      pattern.lastIndex = 0;
      const rawMatched = pattern.test(sanitized);
      let foldedMatched = rawMatched;
      if (textWasFolded) {
        pattern.lastIndex = 0;
        foldedMatched = pattern.test(scanText);
      }

      if (rawMatched || foldedMatched) {
        warnings.push({
          type,
          severity,
          pattern: pattern.source.substring(0, 80),
          description,
        });
      }
      // 折叠后才命中，说明 NFKC 或去掉零宽字符揭开了原文对不上的模式。
      if (foldedMatched && !rawMatched) unicodeObfuscationDetected = true;
    }

    // 有意升档：被 NFKC 或零宽揭开的模式（含 low 的中文模式）另记一条 high，让日志看见规避，不改模式自身严重度。
    if (unicodeObfuscationDetected) {
      warnings.push({
        type: 'prompt_injection',
        severity: 'high',
        pattern: 'unicode-obfuscation',
        description: 'Unicode normalization or zero-width characters obscured a prompt injection pattern',
      });
    }

    // 2. 原文凭证按出现次数逐条保留；折叠副本只补多出来的次数。
    appendSensitiveDataWarnings(warnings, sanitized, scanText, textWasFolded);

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
        scope,
      });
    }

    return {
      safe,
      sanitized,
      warnings,
      blocked,
      riskScore,
      nonce,
      strippedSpecialTokens,
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

/** Fail-closed persist path for memory writes (strict scope). Throws if blocked. */
export function admitStrictUntrustedText(text: string, source: string): string {
  const result = getInputSanitizer().sanitize(text, source, { scope: 'strict' });
  if (result.blocked) {
    throw new Error(
      `Content blocked by security scan: ${result.warnings.map((warning) => warning.description).join('; ')}`,
    );
  }
  return result.sanitized;
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
