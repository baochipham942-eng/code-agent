// ============================================================================
// 开场形状断言 — 产物任务「先产还是先拖延」的确定性判据（方案 D 二期遗留）
// ============================================================================
// 背景：cowork 用例的断言是 file_exists / content_contains，测「最后有没有产出
// 文件」——**测不到「怎么开场」**。而开场正是产物提示词改的东西，于是 18/19 在旧
// 提示词下就已 pass（天花板效应），pass/fail 口径对这类改动没有读数空间。
//
// 二期 dogfood 实测到的三种开场失败，形状是同一个「产出骨架之前先干了别的」：
//   - 旧提示词：首轮 WebSearch ×2（先调研）—— MiniMax + DeepSeek 两模型复现
//   - 关掉调研门后：首轮 AskUserQuestion（先问用途/受众）
//   - 再关提问门后：首轮 ListDirectory → AskUserQuestion（先翻一圈再问）
// 三者都能靠 toolExecutions 的**顺序**确定性判定，不需要 LLM judge：
// judge 分要进可信列得先过 κ≥0.6 × 20 配对的校准门（calibrationRegistry.ts），
// 而本断言天生是 deterministic 桶。judge 只在「有没有把假设摆明」这类语义项上
// 不可替代 —— 那是另一件事。
//
// 窗口语义与 sim_no_write_before_rule 同构（assertionEngine.ts）：锚点之前的窗口内
// 零违规调用。差别只是锚点从「模拟规则命中」换成「首个产物动作」。
//
// 刻意不设默认工具表：什么算「调研」是**按用例**定的。「介绍我司项目的 PPT」先读
// 用户给的材料是对的，「Q3 营销方案 PPT」先 WebSearch 就是拖延——同一个 Read/
// WebSearch 在两个用例里极性相反。全局默认表必然在其中一边制造假红/假绿。
// ============================================================================

import type { ToolExecutionRecord } from './types';

export interface OpeningShapeEvaluation {
  passed: boolean;
  actual: string;
  expected: string;
  details?: string;
}

function invalid(reason: string): OpeningShapeEvaluation {
  return {
    passed: false,
    actual: `invalid params: ${reason}`,
    expected: 'valid no_stall_before_artifact params',
  };
}

function readPatternList(value: unknown, key: string): string[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.some((p) => typeof p !== 'string')) {
    return `${key} must be a non-empty string array`;
  }
  return value as string[];
}

/**
 * no_stall_before_artifact 断言：首个产物动作之前，零拖延调用。
 *
 * params：
 * - artifact_tools（必填，regex 列表）—— 什么算「开始产出产物」，锚点由它定位。
 * - stall_tools（必填，regex 列表）—— 该用例下什么算「拖延」（调研/提问/翻目录）。
 *
 * fail-loud：缺参 / 两表有交集（锚点自我抵消，判据无意义）/ 全程没有任何产物动作，
 * 一律显式 fail —— 绝不假绿。尤其「压根没产出」必须红：那种情况下「开场没拖延」
 * 恰好会因为窗口为空而真空通过，是最危险的假绿。
 */
export function evaluateNoStallBeforeArtifactExpectation(
  params: Record<string, unknown>,
  toolExecutions: ToolExecutionRecord[],
): OpeningShapeEvaluation {
  const artifactTools = readPatternList(params.artifact_tools, 'artifact_tools');
  if (typeof artifactTools === 'string') return invalid(artifactTools);
  const stallTools = readPatternList(params.stall_tools, 'stall_tools');
  if (typeof stallTools === 'string') return invalid(stallTools);

  // 大小写不敏感（与 sim_* 同口径）：工具名变体不许绕过判据
  const matches = (patterns: string[], tool: string) =>
    patterns.some((p) => new RegExp(p, 'i').test(tool));

  // 两表交集 = 同一个调用既是锚点又是违规，判据自相矛盾。宁可报错也不给个说不清的读数。
  const overlap = artifactTools.filter((a) =>
    stallTools.some((s) => a === s || new RegExp(s, 'i').test(a) || new RegExp(a, 'i').test(s)),
  );
  if (overlap.length > 0) {
    return invalid(`artifact_tools and stall_tools overlap on [${overlap.join(', ')}]`);
  }

  const expected = `no stall tool (${stallTools.join(' | ')}) before the first artifact action (${artifactTools.join(' | ')})`;

  const anchorIndex = toolExecutions.findIndex((te) => matches(artifactTools, te.tool));
  if (anchorIndex === -1) {
    return {
      passed: false,
      actual: 'no artifact action ever fired — the run never started producing',
      expected,
      details: `scanned ${toolExecutions.length} tool executions: ${toolExecutions.map((t) => t.tool).join(' → ') || '(none)'}`,
    };
  }

  const window = toolExecutions.slice(0, anchorIndex);
  const violations = window.filter((te) => matches(stallTools, te.tool));

  return {
    passed: violations.length === 0,
    actual:
      violations.length === 0
        ? 'produced first, no stalling before the artifact action'
        : `stalled before producing: ${violations.map((v) => v.tool).join(', ')}`,
    expected,
    details: `first artifact action "${toolExecutions[anchorIndex].tool}" at index ${anchorIndex}; scanned ${window.length} executions before it: ${window.map((t) => t.tool).join(' → ') || '(none)'}`,
  };
}
