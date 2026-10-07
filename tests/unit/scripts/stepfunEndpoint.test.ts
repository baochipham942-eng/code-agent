import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveStepfunBaseUrl } from '../../../scripts/acceptance/stepfunEndpoint';

const stepfunEvalScripts = [
  'jev-inject-layer-eval.ts',
  'jev-intent-route-eval.ts',
  'jev-skill-rerank-eval.ts',
  'ls-tail-read-eval.ts',
  'viz-numbers-from-code-eval.ts',
  'write-xform-guard-eval.ts',
];

describe('StepFun endpoint resolution', () => {
  it('uses the Step Plan endpoint by default', () => {
    expect(resolveStepfunBaseUrl({})).toBe('https://api.stepfun.com/step_plan/v1');
  });

  it('trims and strips trailing slashes from an environment override', () => {
    expect(resolveStepfunBaseUrl({ STEPFUN_BASE_URL: ' https://example.test/v9/ ' })).toBe('https://example.test/v9');
  });

  it('falls back to the Step Plan endpoint for empty or whitespace overrides', () => {
    expect(resolveStepfunBaseUrl({ STEPFUN_BASE_URL: '' })).toBe('https://api.stepfun.com/step_plan/v1');
    expect(resolveStepfunBaseUrl({ STEPFUN_BASE_URL: '   ' })).toBe('https://api.stepfun.com/step_plan/v1');
  });

  it('keeps the pay-as-you-go StepFun URL out of all six eval scripts', () => {
    for (const script of stepfunEvalScripts) {
      const source = readFileSync(path.resolve('scripts/acceptance', script), 'utf8');
      expect(source, script).not.toContain('api.stepfun.com/v1');
    }
  });
});
