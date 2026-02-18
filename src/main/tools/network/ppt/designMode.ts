// ============================================================================
// Design Mode — 编排入口
// ============================================================================
// 三层降级：L1 错误修复 → L2 简化重试 → L3 返回失败（降级到 generate）
// VLM 审查：最多 2 轮修订
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ThemeConfig, ResearchContext, VlmCallback } from './types';
import { buildScaffold } from './designScaffold';
import { buildDesignPrompt, buildRevisionPrompt, buildErrorFixPrompt } from './designPrompt';
import { extractSlideCode, sanitizeCode, executeDesignScript, validateOutput } from './designExecutor';
import { reviewPresentation, summarizeReview, isLibreOfficeAvailable } from './visualReview';
import { createLogger } from '../../../services/infra/logger';
import { DESIGN_MODE } from './constants';

const logger = createLogger('DesignMode');

export interface DesignModeParams {
  topic: string;
  slideCount: number;
  theme: ThemeConfig;
  outputPath: string;
  projectRoot: string;
  modelCallback: (prompt: string) => Promise<string>;
  vlmCallback?: VlmCallback;
  researchContext?: ResearchContext;
  enableReview?: boolean;
}

export interface DesignModeResult {
  success: boolean;
  outputPath?: string;
  slidesCount?: number;
  iterations: number;
  fallbackUsed: boolean;
  error?: string;
}

/**
 * 执行设计模式完整流程
 */
export async function executeDesignMode(params: DesignModeParams): Promise<DesignModeResult> {
  const {
    topic, slideCount, theme, outputPath, projectRoot,
    modelCallback, vlmCallback, researchContext, enableReview = true,
  } = params;

  let iterations = 0;
  let lastSlideCode: string | null = null;
  let lastError: string | null = null;

  // ── Phase 1: 生成 slide 代码 ──
  logger.debug(`Design mode: topic="${topic}", slides=${slideCount}, theme=${theme.name}`);

  const prompt = buildDesignPrompt(topic, slideCount, theme, researchContext);
  let llmResponse: string;
  try {
    llmResponse = await modelCallback(prompt);
  } catch (err: any) {
    logger.warn(`Design mode LLM call failed: ${err.message}`);
    return { success: false, iterations: 0, fallbackUsed: false, error: `LLM call failed: ${err.message}` };
  }

  lastSlideCode = extractSlideCode(llmResponse);
  if (!lastSlideCode) {
    logger.warn('Design mode: failed to extract slide code from LLM response');
    return { success: false, iterations: 0, fallbackUsed: false, error: 'Failed to extract slide code' };
  }

  // ── Phase 2: 安全检查 + 执行（含 L1/L2 降级） ──
  const execResult = await tryExecute(lastSlideCode, theme, outputPath, projectRoot);
  iterations++;

  if (!execResult.success && execResult.error) {
    // L1: 将错误注入 prompt，LLM 修复
    logger.debug('Design mode L1: attempting error fix');
    lastError = execResult.error;

    const fixPrompt = buildErrorFixPrompt(lastSlideCode, lastError);
    try {
      const fixResponse = await modelCallback(fixPrompt);
      const fixedCode = extractSlideCode(fixResponse);
      if (fixedCode) {
        lastSlideCode = fixedCode;
        const retryResult = await tryExecute(fixedCode, theme, outputPath, projectRoot);
        iterations++;

        if (!retryResult.success) {
          // L2: 简化 prompt，减少页数
          logger.debug('Design mode L2: simplified retry');
          const simplifiedCount = Math.min(slideCount, DESIGN_MODE.SIMPLIFIED_SLIDE_COUNT);
          const simplePrompt = buildDesignPrompt(topic, simplifiedCount, theme);
          try {
            const simpleResponse = await modelCallback(simplePrompt);
            const simpleCode = extractSlideCode(simpleResponse);
            if (simpleCode) {
              lastSlideCode = simpleCode;
              const simpleResult = await tryExecute(simpleCode, theme, outputPath, projectRoot);
              iterations++;

              if (!simpleResult.success) {
                // L3: 彻底失败
                return {
                  success: false, iterations, fallbackUsed: false,
                  error: `All retries failed: ${simpleResult.error}`,
                };
              }
            } else {
              return { success: false, iterations, fallbackUsed: false, error: 'L2: failed to extract code' };
            }
          } catch (err: any) {
            return { success: false, iterations, fallbackUsed: false, error: `L2 LLM failed: ${err.message}` };
          }
        }
      } else {
        return { success: false, iterations, fallbackUsed: false, error: 'L1: failed to extract fixed code' };
      }
    } catch (err: any) {
      return { success: false, iterations, fallbackUsed: false, error: `L1 LLM failed: ${err.message}` };
    }
  } else if (!execResult.success) {
    return { success: false, iterations, fallbackUsed: false, error: execResult.error || 'Execution failed' };
  }

  // ── Phase 3: 验证输出 ──
  const validation = validateOutput(outputPath);
  if (!validation.valid) {
    return { success: false, iterations, fallbackUsed: false, error: validation.reason };
  }

  // ── Phase 4: VLM 审查 + 修订（最多 2 轮） ──
  if (enableReview && isLibreOfficeAvailable() && lastSlideCode) {
    let revisionRound = 0;

    while (revisionRound < DESIGN_MODE.MAX_REVISIONS) {
      try {
        const results = await reviewPresentation(outputPath, modelCallback, vlmCallback);
        if (results.length === 0) break;

        const summary = summarizeReview(results);
        logger.debug(`VLM review round ${revisionRound + 1}: avg=${summary.averageScore}, high=${summary.highSeverityCount}`);

        if (!summary.needsRevision) break;

        // 构建审查问题描述（含 fix 建议）
        const issueLines: string[] = [];
        for (const r of results) {
          if (r.issues.length > 0) {
            issueLines.push(`Slide ${r.slideIndex + 1} (score: ${r.score}/5):`);
            for (const issue of r.issues) {
              const fix = issue.fix ? ` → 修复: ${issue.fix}` : '';
              issueLines.push(`  - [${issue.severity}] ${issue.type}: ${issue.description}${fix}`);
            }
          }
        }

        const revisionPrompt = buildRevisionPrompt(lastSlideCode, issueLines.join('\n'));
        const revisionResponse = await modelCallback(revisionPrompt);
        const revisedCode = extractSlideCode(revisionResponse);

        if (revisedCode) {
          lastSlideCode = revisedCode;
          const revResult = await tryExecute(revisedCode, theme, outputPath, projectRoot);
          iterations++;
          revisionRound++;

          if (!revResult.success) {
            logger.warn(`VLM revision execution failed: ${revResult.error}`);
            break;
          }
        } else {
          logger.warn('Failed to extract revised code');
          break;
        }
      } catch (err: any) {
        logger.warn(`VLM review failed: ${err.message}`);
        break;
      }
    }
  }

  // 计算 slide 数量（从注释统计）
  const slideMatches = lastSlideCode ? lastSlideCode.match(/\/\/\s*---\s*Slide\s+\d+/g) : null;
  const slidesCount = slideMatches ? slideMatches.length : slideCount;

  return {
    success: true,
    outputPath,
    slidesCount,
    iterations,
    fallbackUsed: false,
  };
}

// ============================================================================
// Internal
// ============================================================================

async function tryExecute(
  slideCode: string,
  theme: ThemeConfig,
  outputPath: string,
  projectRoot: string,
): Promise<{ success: boolean; error?: string }> {
  // 安全检查
  const safety = sanitizeCode(slideCode);
  if (!safety.safe) {
    return { success: false, error: `Security check failed: ${safety.reason}` };
  }

  // 构建脚本
  const script = buildScaffold(theme, outputPath, projectRoot, slideCode);

  // 写入临时文件
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, `ppt-design-${Date.now()}.ts`);

  try {
    fs.writeFileSync(scriptPath, script, 'utf-8');
    const result = await executeDesignScript(scriptPath, DESIGN_MODE.SCRIPT_TIMEOUT);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return { success: true };
  } finally {
    // 清理临时文件
    try {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    } catch { /* ignore */ }
  }
}
