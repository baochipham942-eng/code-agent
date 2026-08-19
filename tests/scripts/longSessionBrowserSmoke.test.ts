import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseLongSessionBrowserSmokeOptions,
  selectLongSessionGates,
} from '../../scripts/perf/long-session-browser-smoke.ts';

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
