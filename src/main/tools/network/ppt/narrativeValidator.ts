// ============================================================================
// PPT 叙事流验证
// ============================================================================

import type { SlideData } from './types';

export interface NarrativeIssue {
  type: 'missing_intro' | 'consecutive_data' | 'no_evidence' | 'missing_summary';
  slideIndex?: number;
  message: string;
}

const INTRO_RE = /背景|概述|简介|intro|overview/i;
const EVIDENCE_RE = /数据|案例|实例|证据|研究|调查|data|case|evidence|research/i;
const SUMMARY_RE = /总结|回顾|小结|summary|recap|conclusion/i;
const NUMBER_RE = /\d+[\d.,]*[%万亿KMB]?/i;

/** Check if a slide's points are predominantly numeric (3+ points with digits+units). */
function hasNumbers(slide: SlideData): boolean {
  const numericPoints = slide.points.filter((p) => NUMBER_RE.test(p));
  return numericPoints.length >= 3;
}

/**
 * Validate narrative flow of a PPT presentation.
 * Returns informational warnings (non-blocking).
 */
export function validateNarrative(slides: SlideData[]): NarrativeIssue[] {
  const issues: NarrativeIssue[] = [];
  if (slides.length === 0) return issues;

  // --- Rule 1: missing_intro ---
  const firstContent = slides.find((s) => !s.isTitle && !s.isEnd);
  if (firstContent && !INTRO_RE.test(firstContent.title)) {
    issues.push({
      type: 'missing_intro',
      slideIndex: slides.indexOf(firstContent),
      message: '首页内容页缺少引言/概述标题，建议以背景或概述开场',
    });
  }

  // --- Rule 2: consecutive_data ---
  let consecutive = 0;
  for (let i = 0; i < slides.length; i++) {
    if (hasNumbers(slides[i])) {
      consecutive++;
      if (consecutive >= 3) {
        issues.push({
          type: 'consecutive_data',
          slideIndex: i,
          message: `第 ${i - 1}~${i + 1} 页连续出现数据密集幻灯片，建议穿插分析或过渡页`,
        });
        consecutive = 0; // reset to avoid duplicate warnings for overlapping runs
      }
    } else {
      consecutive = 0;
    }
  }

  // --- Rule 3: no_evidence ---
  const hasEvidence = slides.some(
    (s) =>
      EVIDENCE_RE.test(s.title) || s.points.some((p) => EVIDENCE_RE.test(p)),
  );
  if (!hasEvidence) {
    issues.push({
      type: 'no_evidence',
      message: '整份演示文稿未包含数据/案例/研究等证据支撑，建议补充',
    });
  }

  // --- Rule 4: missing_summary ---
  const contentSlides = slides.filter((s) => !s.isEnd);
  const lastContent = contentSlides[contentSlides.length - 1];
  if (lastContent && !SUMMARY_RE.test(lastContent.title)) {
    issues.push({
      type: 'missing_summary',
      slideIndex: slides.indexOf(lastContent),
      message: '结尾前缺少总结/回顾页，建议在最后添加小结',
    });
  }

  return issues;
}
