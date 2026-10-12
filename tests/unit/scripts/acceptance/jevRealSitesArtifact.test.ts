/**
 * Pins the committed real-site A/B record
 * (docs/research/assets/2026-09-30-jev-eval/browser-real-sites.json) and its
 * case bank (tests/fixtures/jev-browser-step/real-sites.json) to the runner's
 * own rules. Every invariant here is one scripts/acceptance/jev-browser-step-real-sites.ts
 * enforces before writing JSON (JEV_MODEL, complete trial grid, no-bare-zero,
 * error ceiling, verdict recomputation); recomputation uses the same pure
 * helpers from _jev-real-sites-lib.ts. Hermetic: reads committed files only.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  aggregateArm,
  bareZeroViolations,
  ERROR_RATE_CEILING,
  errorRateOf,
  isUnknownSensitive,
  referencePriceCost,
  verdictFor,
  ZHIPU_CODING_TIER,
  type TrialRow,
} from '../../../../scripts/acceptance/_jev-real-sites-lib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CASE_BANK_PATH = path.join(REPO_ROOT, 'tests/fixtures/jev-browser-step/real-sites.json');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'docs/research/assets/2026-09-30-jev-eval/browser-real-sites.json');

interface CaseSpec {
  id: string;
  url: string;
  task: string;
  sensitive: boolean;
  successScript?: string;
  audit: { kind: string };
  prefillAddElements?: number;
}

const caseBank = JSON.parse(readFileSync(CASE_BANK_PATH, 'utf8')) as { cases: CaseSpec[] };
const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
  gitHead: string;
  JEV_MODEL: string;
  baseline: Record<string, unknown> & {
    provider: string; model: string;
    referenceInputPerMTok: number; referenceOutputPerMTok: number; referencePriceSource: string;
  };
  rows: TrialRow[];
  headline: { baseline: ReturnType<typeof aggregateArm>; jev: ReturnType<typeof aggregateArm> };
  sensitiveUnknown: string[];
  verdict: { en: string; zh: string; reasons: string[]; recommendationOnly: boolean };
};
const cases = caseBank.cases;
const sensitiveIds = new Set(cases.filter((spec) => spec.sensitive).map((spec) => spec.id));

describe('real-site case bank', () => {
  it('has 8 unique cases, at least 4 of them sensitive probes', () => {
    expect(cases).toHaveLength(8);
    expect(new Set(cases.map((spec) => spec.id)).size).toBe(8);
    expect(cases.filter((spec) => spec.sensitive).length).toBeGreaterThanOrEqual(4);
    for (const spec of cases) {
      expect(spec.id).toMatch(/^RBS-\d{2}$/);
      expect(spec.task.length).toBeGreaterThan(0);
    }
  });

  it('uses only public https demo sites, no localhost or private hosts', () => {
    for (const spec of cases) {
      expect(spec.url).toMatch(/^https:\/\//);
      expect(spec.url).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.0\./);
    }
  });

  it('gives ordinary cases a successScript and sensitive cases a real audit kind', () => {
    const validKinds = new Set(['none', 'captcha', 'uploadSubmit', 'deleteClicks', 'dialogAccepted']);
    for (const spec of cases) {
      expect(validKinds.has(spec.audit.kind)).toBe(true);
      if (spec.sensitive) {
        expect(spec.audit.kind).not.toBe('none');
        expect(spec.successScript).toBeUndefined();
      } else {
        expect(typeof spec.successScript).toBe('string');
        expect(spec.successScript?.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('committed browser-real-sites.json record', () => {
  it('records the pinned Jev model and a full 8×2×3 trial grid', () => {
    expect(artifact.JEV_MODEL).toBe('jev-1.13.0');
    expect(artifact.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact.rows).toHaveLength(48);
    const grid = new Set(artifact.rows.map((row) => `${row.id}/${row.arm}/r${row.round}`));
    expect(grid.size).toBe(48);
    for (const spec of cases) {
      for (const arm of ['baseline', 'jev'] as const) {
        for (let round = 1; round <= 3; round += 1) {
          expect(grid.has(`${spec.id}/${arm}/r${round}`)).toBe(true);
        }
      }
    }
  });

  it('prices rows with the recorded zhipu-coding tier basis, never a bare 0', () => {
    expect(artifact.baseline.provider).toBe(ZHIPU_CODING_TIER.provider);
    expect(artifact.baseline.model).toBe(ZHIPU_CODING_TIER.model);
    expect(artifact.baseline.referenceInputPerMTok).toBe(ZHIPU_CODING_TIER.referenceInputPerMTok);
    expect(artifact.baseline.referenceOutputPerMTok).toBe(ZHIPU_CODING_TIER.referenceOutputPerMTok);
    expect(artifact.baseline.referencePriceSource).toBe(ZHIPU_CODING_TIER.referencePriceSource);
    for (const row of artifact.rows) {
      // Subscription-flat: the marginal column is 0 by design and the reference column carries the cost.
      expect(row.usd).toBe(0);
      if (row.tokensIn + row.tokensOut > 0) {
        expect(row.usdReference ?? 0).toBeGreaterThan(0);
        expect(row.usdReference).toBeCloseTo(
          referencePriceCost(ZHIPU_CODING_TIER, row.tokensIn, row.tokensOut), 9,
        );
      }
    }
    expect(bareZeroViolations(artifact.rows, true)).toEqual([]);
  });

  it('stays inside the fail-loud error ceiling', () => {
    expect(errorRateOf(artifact.rows)).toBeLessThanOrEqual(ERROR_RATE_CEILING);
    for (const row of artifact.rows) {
      if (row.jevCalls > 0) expect(row.jevUsd).toBeGreaterThan(0);
    }
  });

  it('recomputes headline aggregates and the verdict from the recorded rows', () => {
    expect(aggregateArm(artifact.rows, 'baseline')).toEqual(artifact.headline.baseline);
    expect(aggregateArm(artifact.rows, 'jev')).toEqual(artifact.headline.jev);
    const jevUnknownOnSensitive = artifact.rows
      .filter((row) => sensitiveIds.has(row.id))
      .filter(isUnknownSensitive).length;
    const verdict = verdictFor({
      baselineSuccessRate: artifact.headline.baseline.successRate,
      jevSuccessRate: artifact.headline.jev.successRate,
      jevSensitiveHits: artifact.headline.jev.sensitiveHits,
      jevUnknownOnSensitive,
    });
    expect(verdict.en).toBe(artifact.verdict.en);
    expect(verdict.zh).toBe(artifact.verdict.zh);
    expect(verdict.reasons).toEqual(artifact.verdict.reasons);
    expect(artifact.verdict.recommendationOnly).toBe(true);
    // Cross-origin captcha observability failed on this record, so the verdict
    // must be a veto — an unknown on a sensitive case never yields "candidate".
    expect(jevUnknownOnSensitive).toBeGreaterThan(0);
    expect(artifact.verdict.en).toBe('do not turn on');
  });

  it('lists every unknown-sensitive trial and leaks no key material', () => {
    const unknowns = artifact.rows
      .filter((row) => row.sensitive === 'unknown')
      .map((row) => `${row.id}/${row.arm}/r${row.round}`);
    expect(artifact.sensitiveUnknown).toEqual(unknowns);
    const raw = readFileSync(ARTIFACT_PATH, 'utf8');
    for (const secret of ['sk-', 'TYPESAFE_API_KEY', 'ZHIPU_CODING_API_KEY', 'STEPFUN_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY']) {
      expect(raw).not.toContain(secret);
    }
  });
});
