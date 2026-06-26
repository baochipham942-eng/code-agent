/**
 * General-purpose dashboard subtype checker.
 *
 * 通用 dashboard checker，没有领域特化。PR-C 起接入 HTML_PROBES（declarative
 * regex 类）；PR-D 加 imperative browser probe；PR-E 加 anti-Potemkin
 * state_change_on_click。
 *
 * Probe runner 设计（仿 GeneralDeckChecker，差别是 imperative.evaluate 是 async
 * 且 declarative probe 评估 raw HTML 文本）:
 * - declarative probe → 用预读的 htmlContent 评估 predicate → 按 expectation 判定
 * - imperative probe → 直接 await evaluate(input) 拿 ProbeResult
 *
 * 文件 I/O 策略：lazy read。只有 probes 里至少有一个 declarative 时才读 file。
 * 读到的 content 给所有 declarative probe 共用，避免重复 I/O。
 */

import { readFile } from 'fs/promises';

import type { BrowserVisualSmokeSummary } from '../../browser/types';
import type {
  DashboardArtifactInput,
  DashboardCheckResult,
  DashboardDeclarativeProbe,
  DashboardImperativeProbe,
  DashboardPredicate,
  DashboardProbeDeclaration,
  DashboardProbeResult,
  DashboardSubtypeChecker,
} from '../types';
import { HTML_PROBES } from './htmlProbes';
import { BROWSER_PROBES } from './browserProbes';
import { INTERACTION_PROBES } from './interactionProbes';

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

function evaluatePredicate(
  predicate: DashboardPredicate,
  htmlContent: string,
): boolean {
  switch (predicate.op) {
    case 'truthy':
      return true;
    case 'html-content-matches': {
      const re = new RegExp(predicate.pattern, predicate.flags ?? '');
      return re.test(htmlContent);
    }
    case 'html-content-not-matches': {
      const re = new RegExp(predicate.pattern, predicate.flags ?? '');
      return !re.test(htmlContent);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-probe evaluators
// ---------------------------------------------------------------------------

function evaluateDeclarative(
  probe: DashboardDeclarativeProbe,
  htmlContent: string,
): DashboardProbeResult {
  const result = evaluatePredicate(probe.predicate, htmlContent);
  const expected = probe.expectation === 'expect-true';

  if (result === expected) {
    return { probe: probe.id, passed: true };
  }
  return {
    probe: probe.id,
    passed: false,
    failure: probe.failureMessage,
  };
}

async function evaluateImperative(
  probe: DashboardImperativeProbe,
  input: DashboardArtifactInput,
): Promise<DashboardProbeResult> {
  return probe.evaluate(input);
}

// ---------------------------------------------------------------------------
// Checker class
// ---------------------------------------------------------------------------

export class GeneralDashboardChecker implements DashboardSubtypeChecker {
  readonly subtype = 'general';
  /**
   * Probe 顺序：declarative HTML 类（cheap，文本 regex）在前 → imperative
   * browser visual smoke（贵，要 launch Playwright）→ anti-Potemkin
   * interaction probe（最贵，要 launch + click + 等待 mutation）。顺序
   * 不影响判定，但保留对调试输出更直观。
   */
  readonly probes: readonly DashboardProbeDeclaration[] = [
    ...HTML_PROBES,
    ...BROWSER_PROBES,
    ...INTERACTION_PROBES,
  ];

  async validate(input: DashboardArtifactInput): Promise<DashboardCheckResult> {
    const hasDeclarative = this.probes.some((p) => p.kind === 'declarative');

    let htmlContent: string | null = null;
    let readError: Error | null = null;
    if (hasDeclarative) {
      try {
        htmlContent = await readFile(input.filePath, 'utf-8');
      } catch (err) {
        readError = err instanceof Error ? err : new Error(String(err));
      }
    }

    const probeResults: DashboardProbeResult[] = [];
    for (const probe of this.probes) {
      if (probe.kind === 'declarative') {
        if (readError !== null || htmlContent === null) {
          probeResults.push({
            probe: probe.id,
            passed: false,
            failure: `无法读取 dashboard artifact (${input.filePath}): ${readError?.message ?? 'content unavailable'}`,
          });
        } else {
          probeResults.push(evaluateDeclarative(probe, htmlContent));
        }
      } else {
        probeResults.push(await evaluateImperative(probe, input));
      }
    }

    const failures = probeResults
      .filter((r) => !r.passed && r.failure)
      .map((r) => r.failure as string);

    // 把 browser_visual_smoke probe 的 BrowserVisualSmokeSummary 提到顶层
    // 字段，给上游 repair prompt / 调试用。Diagnostics 里仍保留一份冗余。
    const browserVisualSmoke = extractBrowserVisualSmoke(probeResults);

    return {
      passed: probeResults.every((r) => r.passed),
      probes: probeResults,
      failures,
      subtype: this.subtype,
      ...(browserVisualSmoke ? { browserVisualSmoke } : {}),
    };
  }
}

function extractBrowserVisualSmoke(
  results: readonly DashboardProbeResult[],
): BrowserVisualSmokeSummary | undefined {
  const result = results.find((r) => r.probe === 'browser_visual_smoke');
  const summary = result?.diagnostics?.browserVisualSmoke;
  if (!summary || typeof summary !== 'object') return undefined;
  // 弱类型边界 — runtime 拿不到原 generic 信息，强 cast 给上游。
  return summary as BrowserVisualSmokeSummary;
}
