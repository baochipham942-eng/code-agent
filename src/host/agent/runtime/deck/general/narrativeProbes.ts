/**
 * Narrative probes — Phase 4 PR-2 step 2.
 *
 * Backward-compatible port of src/host/tools/media/ppt/narrativeValidator.ts
 * (4 rules: missing_intro / consecutive_data / no_evidence / missing_summary)
 * into the DeckProbeDeclaration shape.
 *
 * Mode split:
 *   - 3/4 rules are declarative (scope + predicate)
 *   - 1/4 (consecutive_data) uses the imperative escape hatch — sliding-window
 *     counting doesn't fit cleanly into scope+predicate without growing the
 *     declarative language with quantifiers, which we explicitly chose not
 *     to do in this PR (see types.ts header).
 *
 * Regex SSOT: these patterns intentionally mirror narrativeValidator.ts.
 * The 8 backward-compat tests in __tests__/narrativeProbes.test.ts pin the
 * two implementations to identical behaviour — if narrativeValidator changes
 * regex without updating here, those tests fail. PR-3 will delete
 * narrativeValidator.ts and these become the single source of truth.
 */

import type { SlideData } from '../../../../tools/media/ppt/types';
import {
  NARRATIVE_NUMERIC_THRESHOLD,
  NARRATIVE_MAX_CONSECUTIVE_DATA,
} from '../../../../tools/media/ppt/constants';
import type { DeckProbeDeclaration, DeckProbeResult, DeckArtifactInput } from '../types';

// ---------------------------------------------------------------------------
// Regex patterns (mirror narrativeValidator.ts)
// ---------------------------------------------------------------------------

/** Mirror of narrativeValidator.ts INTRO_RE — 首页内容页应当含的关键词 */
const INTRO_PATTERN = '背景|概述|简介|intro|overview';

/** Mirror of narrativeValidator.ts EVIDENCE_RE — 证据/数据关键词 */
const EVIDENCE_PATTERN = '数据|案例|实例|证据|研究|调查|data|case|evidence|research';

/** Mirror of narrativeValidator.ts SUMMARY_RE — 总结/回顾关键词 */
const SUMMARY_PATTERN = '总结|回顾|小结|summary|recap|conclusion';

/** Mirror of narrativeValidator.ts NUMBER_RE — 用于 consecutive_data 的数字检测 */
const NUMBER_RE = /\d+[\d.,]*[%万亿KMB]?/i;

// ---------------------------------------------------------------------------
// Imperative probe: consecutive_data (sliding window over numeric-heavy slides)
// ---------------------------------------------------------------------------

/**
 * 检测连续 ≥ NARRATIVE_MAX_CONSECUTIVE_DATA 张数据密集 slide。
 * 数据密集 = slide.points 中含 ≥ NARRATIVE_NUMERIC_THRESHOLD 个数字点。
 *
 * 行为镜像 narrativeValidator.validateNarrative 的 Rule 2，包括它的 reset
 * 边界（命中后重置 consecutive 计数避免重叠 slide 重复报警）。
 */
function evaluateConsecutiveData(deck: DeckArtifactInput): DeckProbeResult {
  const slides = deck.legacy;
  let consecutive = 0;
  for (let i = 0; i < slides.length; i++) {
    if (hasNumbers(slides[i])) {
      consecutive++;
      if (consecutive >= NARRATIVE_MAX_CONSECUTIVE_DATA) {
        return {
          probe: 'consecutive_data',
          passed: false,
          failure: `第 ${i - 1}~${i + 1} 页连续出现数据密集幻灯片，建议穿插分析或过渡页`,
          affectedSlideIndex: i,
        };
      }
    } else {
      consecutive = 0;
    }
  }
  return { probe: 'consecutive_data', passed: true };
}

function hasNumbers(slide: SlideData): boolean {
  const numericPoints = slide.points.filter((p) => NUMBER_RE.test(p));
  return numericPoints.length >= NARRATIVE_NUMERIC_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Probe declarations
// ---------------------------------------------------------------------------

/**
 * 4 条 narrative 规则的 declarative + imperative 混合表达。
 * GeneralDeckChecker 直接消费这个数组。
 */
export const NARRATIVE_PROBES: readonly DeckProbeDeclaration[] = [
  {
    id: 'missing_intro',
    kind: 'declarative',
    scope: { type: 'first-content' },
    predicate: { op: 'title-matches', pattern: INTRO_PATTERN, flags: 'i' },
    expectation: 'expect-true',
    failureMessage: '首页内容页缺少引言/概述标题，建议以背景或概述开场',
  },
  {
    id: 'consecutive_data',
    kind: 'imperative',
    description: '连续 ≥3 张数据密集（每张 ≥3 个数字点）幻灯片触发警告',
    evaluate: evaluateConsecutiveData,
  },
  {
    id: 'no_evidence',
    kind: 'declarative',
    scope: { type: 'any' },
    predicate: { op: 'title-or-points-matches', pattern: EVIDENCE_PATTERN, flags: 'i' },
    expectation: 'expect-some',
    failureMessage: '整份演示文稿未包含数据/案例/研究等证据支撑，建议补充',
  },
  {
    id: 'missing_summary',
    kind: 'declarative',
    scope: { type: 'last-content' },
    predicate: { op: 'title-matches', pattern: SUMMARY_PATTERN, flags: 'i' },
    expectation: 'expect-true',
    failureMessage: '结尾前缺少总结/回顾页，建议在最后添加小结',
  },
];
