/**
 * General-purpose deck subtype checker — Phase 4 PR-2 step 3.
 *
 * 通用 deck checker，没有领域特化（executive-deck / academic-paper / data-report
 * 这些 future subtypes 会按需注册更窄的 probe 集合）。
 *
 * 行为镜像 src/main/tools/media/ppt/narrativeValidator.ts。
 *
 * Probe runner 设计：
 * - imperative probe → 直接调用 evaluate(deck) 拿 ProbeResult
 * - declarative probe → resolve scope → apply predicate → aggregate by expectation
 *
 * 边界 case 镜像 narrativeValidator：legacy slides 为空时早 return（全 pass，
 * 0 issues），不进 probe 求值。
 */

import type { SlideData } from '../../../../tools/media/ppt/types';
import type {
  DeckArtifactInput,
  DeckCheckResult,
  DeckProbeDeclaration,
  DeckProbeResult,
  DeckSubtypeChecker,
  DeclarativeProbe,
  ImperativeProbe,
  SlidePredicate,
  SlideScope,
} from '../types';
import { NARRATIVE_PROBES } from './narrativeProbes';

// ---------------------------------------------------------------------------
// Scope resolution — pick which slides a declarative probe should evaluate
// ---------------------------------------------------------------------------

function resolveScope(scope: SlideScope, slides: readonly SlideData[]): readonly SlideData[] {
  switch (scope.type) {
    case 'first-content': {
      const slide = slides.find((s) => !s.isTitle && !s.isEnd);
      return slide ? [slide] : [];
    }
    case 'last-content': {
      // 最后一个 isEnd=false 的 slide（含 isTitle）
      const contentSlides = slides.filter((s) => !s.isEnd);
      return contentSlides.length > 0 ? [contentSlides[contentSlides.length - 1]] : [];
    }
    case 'any':
    case 'all':
      return slides;
  }
}

// ---------------------------------------------------------------------------
// Predicate evaluation — does a single slide satisfy the predicate?
// ---------------------------------------------------------------------------

function evaluatePredicate(predicate: SlidePredicate, slide: SlideData): boolean {
  switch (predicate.op) {
    case 'title-matches': {
      const re = new RegExp(predicate.pattern, predicate.flags ?? '');
      return re.test(slide.title);
    }
    case 'title-or-points-matches': {
      const re = new RegExp(predicate.pattern, predicate.flags ?? '');
      if (re.test(slide.title)) return true;
      return slide.points.some((p) => re.test(p));
    }
    case 'truthy':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Per-probe evaluators
// ---------------------------------------------------------------------------

function evaluateDeclarative(
  probe: DeclarativeProbe,
  deck: DeckArtifactInput,
): DeckProbeResult {
  const slides = deck.legacy;
  const targets = resolveScope(probe.scope, slides);

  // Empty target set:
  //   expect-true vacuously passes (mirror narrativeValidator: only fails when
  //     a "first content slide" or "last content slide" exists).
  //   expect-some fails — no slide in scope can satisfy.
  if (targets.length === 0) {
    return {
      probe: probe.id,
      passed: probe.expectation === 'expect-true',
      failure: probe.expectation === 'expect-some' ? probe.failureMessage : undefined,
    };
  }

  const matches = targets.map((s) => evaluatePredicate(probe.predicate, s));

  if (probe.expectation === 'expect-true') {
    // 全部 target 必须满足
    const failedIdx = matches.findIndex((ok) => !ok);
    if (failedIdx === -1) return { probe: probe.id, passed: true };
    const failedSlide = targets[failedIdx];
    const slideIndex = slides.indexOf(failedSlide);
    return {
      probe: probe.id,
      passed: false,
      failure: probe.failureMessage,
      affectedSlideIndex: slideIndex >= 0 ? slideIndex : undefined,
    };
  }

  // expect-some: 至少一张满足
  if (matches.some((ok) => ok)) return { probe: probe.id, passed: true };
  return { probe: probe.id, passed: false, failure: probe.failureMessage };
}

function evaluateImperative(
  probe: ImperativeProbe,
  deck: DeckArtifactInput,
): DeckProbeResult {
  return probe.evaluate(deck);
}

function evaluateProbe(
  probe: DeckProbeDeclaration,
  deck: DeckArtifactInput,
): DeckProbeResult {
  return probe.kind === 'declarative'
    ? evaluateDeclarative(probe, deck)
    : evaluateImperative(probe, deck);
}

// ---------------------------------------------------------------------------
// Checker class
// ---------------------------------------------------------------------------

export class GeneralDeckChecker implements DeckSubtypeChecker {
  readonly subtype = 'general';
  readonly probes: readonly DeckProbeDeclaration[] = NARRATIVE_PROBES;

  validate(deck: DeckArtifactInput): DeckCheckResult {
    // 边界 case：空 deck 早 return（镜像 narrativeValidator.validateNarrative 行为）
    if (deck.legacy.length === 0) {
      return {
        passed: true,
        probes: this.probes.map((p) => ({ probe: p.id, passed: true })),
        failures: [],
        subtype: this.subtype,
      };
    }

    const probeResults = this.probes.map((p) => evaluateProbe(p, deck));
    const failures = probeResults
      .filter((r) => !r.passed && r.failure)
      .map((r) => r.failure as string);

    return {
      passed: probeResults.every((r) => r.passed),
      probes: probeResults,
      failures,
      subtype: this.subtype,
    };
  }
}
