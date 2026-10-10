/**
 * Guards for the warden.json writer (N-JEV-WARDEN-EVAL rework r1).
 *
 * warden.json is a committed repo artifact, so writeWardenDocument must refuse
 * documents carrying an absolute home-directory path (REVIEW.md pass 2: no
 * absolute home paths in diffs, evidence artifacts included). Part B used to
 * write os.homedir()-based reportPath values straight into the file. The fs
 * spies keep the happy-path case from touching the committed artifact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  writeWardenDocument,
  type ArmAStats,
  type PartBRunMeta,
  type WardenDocument,
} from '../../../../scripts/acceptance/jev-warden-eval-metrics';

function emptyArm(): ArmAStats {
  return { letThrough: 0, steers: {}, falseSteer: 0, jevCalls: 0, jevErrors: 0, usd: 0 };
}

function runMeta(reportPath: string): PartBRunMeta {
  return {
    cliRunId: 'warden-c0-off',
    reportRunId: 'warden-c0-off',
    chunk: 0,
    arm: 'off',
    exitCode: 0,
    actualUsageLine: 'Actual usage (process budget): 1000 in / 100 out',
    processListUsd: 0.001,
    processReportUsd: 0.001,
    reportPath,
  };
}

function docWithRuns(runs: PartBRunMeta[]): WardenDocument {
  return {
    gitHead: '0'.repeat(40),
    JEV_MODEL: 'jev-1.13.0',
    baseline: null,
    partA: { sequences: [], totals: { on: emptyArm(), off: emptyArm() } },
    partB: { complete: false, cases: [], runs },
    recommendation: 'test doc',
  };
}

function mockFs() {
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  const write = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
  return write;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeWardenDocument home-path guard', () => {
  it('refuses a document whose reportPath is an absolute home-directory path', () => {
    const write = mockFs();
    const leaked = path.join(os.homedir(), 'work/out/N-JEV-WARDEN-EVAL/reports/warden-c0-off.json');
    expect(() => writeWardenDocument(docWithRuns([runMeta(leaked)]))).toThrow(/home directory path/);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes a document whose reportPath is relative to the out dir', () => {
    const write = mockFs();
    const relative = path.join('reports', 'warden-c0-off.json');
    expect(() => writeWardenDocument(docWithRuns([runMeta(relative)]))).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    const [, text] = write.mock.calls[0] as unknown as [string, string];
    expect(text).toContain('"reportPath": "reports/warden-c0-off.json"');
    expect(text).not.toContain(os.homedir());
  });
});
