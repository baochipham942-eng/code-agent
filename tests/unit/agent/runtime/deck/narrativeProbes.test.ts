// ============================================================================
// Backward-compat tests — Phase 4 PR-2 step 5.
//
// Pin GeneralDeckChecker / NARRATIVE_PROBES to the exact same behaviour as
// the legacy validateNarrative (src/host/tools/media/ppt/narrativeValidator.ts).
//
// Strategy: on each fixture, run BOTH implementations and compare the set of
// firing probe ids vs issue types. Any drift in either side fails the test —
// either narrativeValidator changed regex without updating NARRATIVE_PROBES,
// or vice versa.
//
// Cases 1–8 are direct ports of ppt-d3d4.test.mjs Part B (B.1–B.8). The B.X
// numbering is preserved in test names so a regression can be cross-referenced
// to the legacy mjs assertions.
// ============================================================================

import { describe, it, expect } from 'vitest';

import type { SlideData } from '../../../../../src/host/tools/media/ppt/types';
import type { NarrativeIssue } from '../../../../../src/host/tools/media/ppt/narrativeValidator';
import { validateNarrative } from '../../../../../src/host/tools/media/ppt/narrativeValidator';
import { GeneralDeckChecker } from '../../../../../src/host/agent/runtime/deck/general/GeneralDeckChecker';
import { DeckVerifier } from '../../../../../src/host/agent/runtime/deck/DeckVerifier';

function legacyTypes(issues: NarrativeIssue[]): Set<string> {
  return new Set(issues.map((i) => i.type));
}

function checkerFailedProbes(slides: SlideData[]): Set<string> {
  const checker = new GeneralDeckChecker();
  const result = checker.validate({ structured: [], legacy: slides });
  return new Set(result.probes.filter((p) => !p.passed).map((p) => p.probe));
}

function assertSameSignals(slides: SlideData[]): { legacy: Set<string>; checker: Set<string> } {
  const legacy = legacyTypes(validateNarrative(slides));
  const checker = checkerFailedProbes(slides);
  expect(checker).toEqual(legacy);
  return { legacy, checker };
}

// ---------------------------------------------------------------------------
// Cases (mirror ppt-d3d4.test.mjs B.1–B.8)
// ---------------------------------------------------------------------------

describe('NARRATIVE_PROBES backward-compat vs validateNarrative', () => {
  it('B.1 missing_intro: first content slide title not matching intro keywords', () => {
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      { title: '产品功能', points: ['功能A', '功能B'], isTitle: false, isEnd: false },
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('missing_intro')).toBe(true);
  });

  it('B.2 no missing_intro: first content slide title is "背景概述"', () => {
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      { title: '背景概述', points: ['内容A'], isTitle: false, isEnd: false },
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('missing_intro')).toBe(false);
  });

  it('B.3 consecutive_data: 3+ slides with 3+ numeric points', () => {
    const makeNumericSlide = (title: string): SlideData => ({
      title,
      points: ['收入 100 万', '增长 20%', '用户 500 万'],
      isTitle: false,
      isEnd: false,
    });
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      makeNumericSlide('数据1'),
      makeNumericSlide('数据2'),
      makeNumericSlide('数据3'),
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('consecutive_data')).toBe(true);
  });

  it('B.4 no consecutive_data: numeric slides interleaved with text', () => {
    const numSlide: SlideData = {
      title: '数据',
      points: ['收入 100 万', '增长 20%', '用户 500 万'],
      isTitle: false,
      isEnd: false,
    };
    const textSlide: SlideData = {
      title: '分析',
      points: ['深入探讨趋势'],
      isTitle: false,
      isEnd: false,
    };
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      numSlide,
      textSlide,
      { ...numSlide, title: '数据2' },
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('consecutive_data')).toBe(false);
  });

  it('B.5 no_evidence: no slides with evidence keywords', () => {
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      { title: '概述', points: ['内容'], isTitle: false, isEnd: false },
      { title: '计划', points: ['步骤一'], isTitle: false, isEnd: false },
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('no_evidence')).toBe(true);
  });

  it('B.6 has evidence: a slide has "数据分析" in title', () => {
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      { title: '数据分析报告', points: ['指标A'], isTitle: false, isEnd: false },
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('no_evidence')).toBe(false);
  });

  it('B.7 missing_summary: last content slide does not match summary keywords', () => {
    const slides: SlideData[] = [
      { title: '标题', points: [], isTitle: true, isEnd: false },
      { title: '背景概述', points: ['内容'], isTitle: false, isEnd: false },
      { title: '数据展示', points: ['指标'], isTitle: false, isEnd: false },
      { title: '谢谢', points: [], isTitle: false, isEnd: true },
    ];
    const { legacy } = assertSameSignals(slides);
    expect(legacy.has('missing_summary')).toBe(true);
  });

  it('B.8 empty slides → no issues from either implementation', () => {
    const { legacy, checker } = assertSameSignals([]);
    expect(legacy.size).toBe(0);
    expect(checker.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DeckVerifier wiring smoke
// ---------------------------------------------------------------------------

describe('DeckVerifier dispatch', () => {
  it('default registry routes to general subtype', () => {
    const verifier = new DeckVerifier();
    const result = verifier.validate({ structured: [], legacy: [] }, 'general');
    expect(result.subtype).toBe('general');
    expect(result.passed).toBe(true);
  });

  it('falls back to general when subtype omitted', () => {
    const verifier = new DeckVerifier();
    const result = verifier.validate({ structured: [], legacy: [] });
    expect(result.subtype).toBe('general');
  });

  it('reports unknown subtype as failure (no throw)', () => {
    const verifier = new DeckVerifier();
    const result = verifier.validate({ structured: [], legacy: [] }, 'executive-deck');
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/Unknown deck subtype/);
  });

  it('listSubtypes exposes registered ids', () => {
    const verifier = new DeckVerifier();
    expect(verifier.listSubtypes()).toContain('general');
  });
});
