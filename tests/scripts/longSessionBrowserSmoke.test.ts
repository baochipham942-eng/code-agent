import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseLongSessionBrowserSmokeOptions,
  selectLongSessionGates,
} from '../../scripts/perf/long-session-browser-smoke.ts';
import {
  isSearchNavigationReady,
  searchListGeometrySignature,
} from '../../scripts/perf/search-navigation-ready.ts';
import {
  waitForStable,
  waitForStableWithRetry,
} from '../../scripts/perf/wait-for-stable.ts';

describe('long-session browser settling', () => {
  it('does not accept a transiently true scroll or visibility condition', async () => {
    let sample = 0;
    const result = await waitForStable(
      () => {
        sample += 1;
        if (sample === 2 || sample >= 5) return sample;
        return null;
      },
      { timeoutMs: 100, stableForMs: 2, pollIntervalMs: 1 },
    );

    expect(result).toBeGreaterThanOrEqual(6);
  });

  it('fails closed when the condition never remains true', async () => {
    let sample = 0;
    const result = await waitForStable(
      () => {
        sample += 1;
        return sample % 2 === 0 ? true : null;
      },
      { timeoutMs: 10, stableForMs: 3, pollIntervalMs: 1 },
    );

    expect(result).toBeNull();
  });

  it('reissues an exact navigation after a bounded settling timeout', async () => {
    let retries = 0;
    const result = await waitForStableWithRetry(
      () => retries > 0 ? 'visible' : null,
      () => { retries += 1; },
      { attempts: 2, timeoutMs: 5, stableForMs: 1, pollIntervalMs: 1 },
    );

    expect(result).toBe('visible');
    expect(retries).toBe(1);
  });
});

describe('long-session search navigation ordering', () => {
  it('does not arm search while the replaced list is still the streaming geometry or has only been seen once', () => {
    const baseline = searchListGeometrySignature(120_000, 110_000);

    expect(isSearchNavigationReady({
      baselineSignature: baseline,
      previousSignature: baseline,
      scrollHeight: 120_000,
      scrollTop: 110_000,
    })).toBe(false);

    expect(isSearchNavigationReady({
      baselineSignature: baseline,
      previousSignature: baseline,
      scrollHeight: 80_000,
      scrollTop: 70_000,
    })).toBe(false);

    expect(isSearchNavigationReady({
      baselineSignature: baseline,
      previousSignature: searchListGeometrySignature(80_000, 70_000),
      scrollHeight: 80_000,
      scrollTop: 70_000,
    })).toBe(true);
  });
});

describe('long-session browser smoke options', () => {
  it('preserves the release evidence path and all seven gates by default', () => {
    const defaultOutput = path.resolve('docs/perf/long-session-gold-latest.json');
    const options = parseLongSessionBrowserSmokeOptions([], defaultOutput);
    const gates = {
      turns500Interactive: true,
      anchorDrift: true,
      userScroll: true,
      streamingFollow: true,
      search: true,
      mainThread: true,
      memoryRecorded: true,
    };

    expect(options).toEqual({ gateProfile: 'full', outputPath: defaultOutput, help: false });
    expect(selectLongSessionGates(gates, options.gateProfile)).toEqual(gates);
  });

  it('writes PR evidence to the requested path and gates only deterministic correctness', () => {
    const output = path.resolve('/tmp/long-session-pr.json');
    const options = parseLongSessionBrowserSmokeOptions([
      '--out', output,
      '--gate-profile', 'correctness',
    ]);
    const gates = selectLongSessionGates({
      turns500Interactive: false,
      anchorDrift: true,
      userScroll: false,
      streamingFollow: true,
      search: true,
      mainThread: false,
      memoryRecorded: false,
    }, options.gateProfile);

    expect(options.outputPath).toBe(output);
    expect(gates).toEqual({ anchorDrift: true, search: true, streamingFollow: true });
    expect(Object.values(gates).every(Boolean)).toBe(true);
  });

  it('fails closed on missing values and unknown profiles', () => {
    expect(() => parseLongSessionBrowserSmokeOptions(['--out'])).toThrow('--out requires a file path.');
    expect(() => parseLongSessionBrowserSmokeOptions(['--gate-profile', 'performance'])).toThrow(
      '--gate-profile must be "full" or "correctness".',
    );
    expect(() => parseLongSessionBrowserSmokeOptions(['--unexpected'])).toThrow('Unknown argument');
  });

  it('keeps the PR workflow repo-wide, temporary-output-only, and correctness-gated', () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../.github/workflows/long-session-scroll-gate.yml'),
      'utf8',
    );

    expect(workflow).toMatch(/^\s*pull_request:/m);
    expect(workflow).not.toMatch(/^\s+paths:/m);
    expect(workflow).toContain('${{ runner.temp }}/long-session-pr-${{ github.sha }}.json');
    expect(workflow).toContain('--out "$LONG_SESSION_REPORT" --gate-profile correctness');
    expect(workflow).toContain('git diff --exit-code -- docs/perf/long-session-gold-latest.json');
    expect(workflow).toContain('timeout-minutes: 20');
    expect(workflow).toContain('run: npx playwright install chromium');
    expect(workflow).not.toContain('npx playwright install --with-deps chromium');
  });
});
