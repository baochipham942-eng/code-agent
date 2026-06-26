/**
 * 设计质量自检 hook——Kun 借鉴的反 AI 痕迹机制在 Neo 的落地。
 *
 * Agent 用 Write/Edit/MultiEdit 写或改前端文件后，本模块扫描产出的源码，
 * 把"AI 设计痕迹"与品味问题格式化成一段 review，由工具执行引擎经
 * `injectSystemMessage` 回注，让模型下一轮自我修正。纯 advisory：不把工具
 * 标记为失败、不拦截本轮——与 Kun 的 PostToolUse 设计质量 hook 行为一致。
 *
 * 本模块是纯函数（源码文本由调用方提供，不读盘），便于单测；读盘/取参等
 * 副作用留在 toolExecutionEngine 的整合层。
 */

import { DESIGN_QUALITY } from '../../shared/constants';
import { detectFrontend, isFrontendPath } from './detect';
import type { DesignFinding, DesignStrictness } from './types';

export type DesignQualityReviewInput = {
  /** 触发的工具名（Write / Edit / MultiEdit …）。 */
  toolName: string;
  /** 被写/改的文件路径，用于扩展名门控与发现上下文。 */
  filePath?: string;
  /** 文件写入后的完整源码文本。 */
  source: string;
  /** 覆盖默认严格度。 */
  strictness?: DesignStrictness;
  /** 覆盖默认启用状态。 */
  enabled?: boolean;
};

const REVIEW_TOOLS = new Set<string>(DESIGN_QUALITY.REVIEW_TOOLS);

const SEVERITY_LABEL: Record<DesignFinding['severity'], string> = {
  warning: '问题',
  advisory: '建议',
};

/**
 * 把发现格式化成回注给模型的 review 文本。空发现返回 null，让调用方据此
 * 决定是否注入。
 */
export function formatDesignReview(
  findings: readonly DesignFinding[],
  filePath?: string,
): string | null {
  if (findings.length === 0) return null;
  const where = filePath ? `\`${filePath}\` ` : '';
  const lines = findings.map((f) => {
    const tag = SEVERITY_LABEL[f.severity] ?? f.severity;
    return `- [${tag}] L${f.line} ${f.message}（${f.snippet}）`;
  });
  return [
    `检测到 ${where}存在 ${findings.length} 处设计质量信号（自动检测，仅供参考，不阻断本轮）：`,
    ...lines,
    '若你认同，请在后续编辑中修正；属误报或有意为之可忽略并简述理由。',
  ].join('\n');
}

/**
 * 对一次前端文件写入运行设计质量自检。当未启用、工具不在自检范围、非前端
 * 文件、源码过大或无发现时返回 null（即无需回注）。绝不抛错。
 */
export function runDesignQualityReview(input: DesignQualityReviewInput): string | null {
  const enabled = input.enabled ?? DESIGN_QUALITY.ENABLED;
  if (!enabled) return null;
  if (!REVIEW_TOOLS.has(input.toolName)) return null;
  if (!isFrontendPath(input.filePath)) return null;
  if (typeof input.source !== 'string' || input.source.length === 0) return null;
  if (input.source.length > DESIGN_QUALITY.MAX_SOURCE_BYTES) return null;

  let findings: DesignFinding[];
  try {
    findings = detectFrontend(input.source, {
      filePath: input.filePath,
      strictness: input.strictness ?? (DESIGN_QUALITY.STRICTNESS as DesignStrictness),
      maxFindings: DESIGN_QUALITY.MAX_FINDINGS,
    });
  } catch {
    // 检测器绝不该拖垮工具结果路径。
    return null;
  }
  return formatDesignReview(findings, input.filePath);
}
