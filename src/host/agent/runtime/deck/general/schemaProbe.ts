/**
 * Schema probe — Phase 4 PR-3 step 1.
 *
 * 把 src/main/tools/media/ppt/slideSchemas.ts validateStructuredSlides
 * 包装成 DeckProbeDeclaration 的 imperative 形态。
 *
 * 为什么是 imperative：schema 验证是 multi-error / per-slide 的复合判定，
 * 单 slide 上的 declarative scope+predicate 表达不出"6 张全 valid + 各自子字段"
 * 这种聚合语义。与其扩展 SlidePredicate 加 multi-error 算子，不如直接走
 * 命令式 escape hatch（types.ts header 已声明这个抽象边界）。
 *
 * 行为镜像 validateStructuredSlides：
 * - 0 个 invalid slide → probe pass
 * - ≥1 invalid slide → probe fail，failure 字符串聚合所有错误
 * - structured 为空 → pass（vacuously，跟 narrativeValidator 空 deck 处理对齐）
 */

import { validateStructuredSlides } from '../../../../tools/media/ppt/slideSchemas';
import type { DeckArtifactInput, DeckProbeDeclaration, DeckProbeResult } from '../types';

const PROBE_ID = 'schema_invalid';

function evaluateSchema(deck: DeckArtifactInput): DeckProbeResult {
  if (deck.structured.length === 0) {
    return { probe: PROBE_ID, passed: true };
  }

  const { errors } = validateStructuredSlides([...deck.structured]);
  if (errors.length === 0) {
    return { probe: PROBE_ID, passed: true };
  }

  // 聚合每张 invalid slide 的错误成可读字符串：
  //   "schema: 2 张 slide 校验失败 — slide 1 (stats: 缺 stats 数组); slide 3 (timeline.steps[0]: 缺 description)"
  const detail = errors
    .map((e) => `slide ${e.index + 1} (${e.errors.join('; ')})`)
    .join('; ');

  return {
    probe: PROBE_ID,
    passed: false,
    failure: `schema: ${errors.length} 张 slide 校验失败 — ${detail}`,
    affectedSlideIndex: errors[0].index,
  };
}

/**
 * Schema probe declaration — imperative。
 * 由 GeneralDeckChecker 串联进 probes 列表。
 */
export const SCHEMA_PROBE: DeckProbeDeclaration = {
  id: PROBE_ID,
  kind: 'imperative',
  description: 'StructuredSlide schema validation — 每张 slide 必须满足 layout 对应字段约束',
  evaluate: evaluateSchema,
};
