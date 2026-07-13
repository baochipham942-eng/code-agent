// ============================================================================
// Declare Deliverables Gate — 拦截 declare_deliverables 写入最终产物契约
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';

function formatPathList(paths: string[]): string {
  return paths.map((item) => `- ${item}`).join('\n');
}

function formatScratchDir(scratchDir: string | undefined): string {
  return scratchDir ? scratchDir : '(未声明)';
}

function buildRejectionMessage(reason: string): string {
  return [
    '<deliverables-declaration-rejected>',
    `declare_deliverables 声明已拒绝：${reason}。`,
    '请重新调用 declare_deliverables，并提供非空的 final_artifacts 字符串数组。',
    '</deliverables-declaration-rejected>',
  ].join('\n');
}

function validateArguments(args: Record<string, unknown> | undefined): {
  ok: true;
  finalArtifacts: string[];
  scratchDir?: string;
} | {
  ok: false;
  reason: string;
} {
  const rawFinalArtifacts = args?.final_artifacts;
  if (!Array.isArray(rawFinalArtifacts)) {
    return { ok: false, reason: 'final_artifacts 必须是非空字符串数组' };
  }

  const finalArtifacts = rawFinalArtifacts.filter((item): item is string => typeof item === 'string');
  if (finalArtifacts.length !== rawFinalArtifacts.length || finalArtifacts.length === 0) {
    return { ok: false, reason: 'final_artifacts 不能为空，且每一项都必须是字符串' };
  }

  const rawScratchDir = args?.scratch_dir;
  if (rawScratchDir !== undefined && typeof rawScratchDir !== 'string') {
    return { ok: false, reason: 'scratch_dir 必须是字符串' };
  }

  return { ok: true, finalArtifacts, scratchDir: rawScratchDir };
}

/**
 * 拦截 declare_deliverables，写入 RuntimeContext.artifact.declaredDeliverables。
 *
 * @returns
 *  - `'continue'` —— 已处理声明/拒绝，并注入系统消息让模型下一轮继续
 *  - `null`       —— 本轮没有 declare_deliverables，不拦截
 */
export function handleDeclareDeliverablesGate(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  toolCalls: ToolCall[],
): 'continue' | null {
  const declarationCall = toolCalls.find((tc) => tc.name === 'declare_deliverables');
  if (!declarationCall) return null;

  const validation = validateArguments(declarationCall.arguments);
  if (!validation.ok) {
    ctx.turnTrace?.record('deliverables_declaration', {
      status: 'rejected',
      reason: validation.reason,
    });
    contextAssembly.injectSystemMessage(buildRejectionMessage(validation.reason));
    return 'continue';
  }

  const previous = ctx.artifact.declareDeliverables({
    finalArtifacts: validation.finalArtifacts,
    scratchDir: validation.scratchDir,
    declaredAtMs: Date.now(),
  });

  ctx.turnTrace?.record('deliverables_declaration', {
    status: previous ? 'overridden' : 'declared',
    finalArtifacts: validation.finalArtifacts,
    scratchDir: validation.scratchDir ?? null,
    previous: previous ? {
      finalArtifacts: previous.finalArtifacts,
      scratchDir: previous.scratchDir ?? null,
      declaredAtMs: previous.declaredAtMs,
    } : null,
  });

  const message = [
    '<deliverables-declared>',
    previous ? '已覆盖之前的声明。' : '已记录最终产物声明。',
    '最终产物：',
    formatPathList(validation.finalArtifacts),
    `草稿目录：${formatScratchDir(validation.scratchDir)}`,
    previous ? [
      '--- 之前的声明 ---',
      '最终产物：',
      formatPathList(previous.finalArtifacts),
      `草稿目录：${formatScratchDir(previous.scratchDir)}`,
    ].join('\n') : '',
    '后续写入、验证和收尾请对齐本声明；如最终路径需要变更，请先重新调用 declare_deliverables。',
    '</deliverables-declared>',
  ].filter(Boolean).join('\n');

  contextAssembly.injectSystemMessage(message);
  return 'continue';
}
