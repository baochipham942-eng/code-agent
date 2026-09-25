import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJourneyBrowserSmokeOptions } from '../../scripts/perf/journey-browser-smoke.ts';
import { selectTests } from '../../scripts/lib/gates-fast-contract.mjs';
import policy from '../../scripts/lib/gates-fast-policy.json';

const script = resolve('scripts/perf-journey-ratchet.mjs');
const roots: string[] = [];

const JOURNEY_FILES = [
  'tests/scripts/perfJourneyColdStart.test.ts',
  'tests/scripts/perfJourneyFirstToken.test.ts',
  'tests/scripts/perfJourneyLongSession.test.ts',
  'tests/scripts/perfJourneySessionSwitch.test.ts',
];

function fixture(commitCount = 3) {
  const root = mkdtempSync(join(tmpdir(), 'perf-journey-ratchet-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/perf-journey-ratchet-baseline.json'), JSON.stringify({
    schemaVersion: 1,
    reason: 'fixture',
    journeys: {
      'cold-start': { commitCount, reason: 'fixture cold-start' },
      'first-token': { commitCount, reason: 'fixture first-token' },
      'long-session': { commitCount, reason: 'fixture long-session' },
      'session-switch': { commitCount, reason: 'fixture session-switch' },
    },
  }));
  return root;
}

function report(journey: string, commitCount: number) {
  return {
    schemaVersion: 1,
    journey,
    commitCount,
    hotRenderCount: 1,
    wallClockMs: 10,
    longTaskCount: 0,
    longTaskMaxMs: 0,
    extraRenders: 0,
    ready: { ok: true },
  };
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [script, '--repo-root', root, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('perf-journey-ratchet', () => {
  it('持平时通过', () => {
    const root = fixture(3);
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report('first-token', 3)));
    const result = run(root, ['--journey', 'first-token', '--report', reportPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('first-token commitCount current=3 baseline=3');
    expect(result.stdout).toContain('✓ first-token commitCount 均未超基线');
  });

  it('计数上升时报红', () => {
    const root = fixture(3);
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report('first-token', 4)));
    const result = run(root, ['--journey', 'first-token', '--report', reportPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('first-token commitCount 上升：3 -> 4');
  });

  it('计数下降时要求同一 PR 下调基线，不自动改写', () => {
    const root = fixture(3);
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report('first-token', 2)));
    const result = run(root, ['--journey', 'first-token', '--report', reportPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('first-token commitCount 下降：3 -> 2');
    expect(result.stderr).toContain('请在同一 PR 把 scripts/perf-journey-ratchet-baseline.json 里该 journey 的 commitCount 降到 2');
  });

  it('基线缺 reason / 缺 journey 都 fail loud', () => {
    const root = fixture(3);
    writeFileSync(join(root, 'scripts/perf-journey-ratchet-baseline.json'), JSON.stringify({
      schemaVersion: 1,
      reason: '',
      journeys: {},
    }));
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report('first-token', 3)));
    expect(run(root, ['--journey', 'first-token', '--report', reportPath]).stderr).toContain('必须保留非空 reason');
  });
});

describe('perf-journey smoke options', () => {
  it('defaults to all journeys and accepts a single journey id', () => {
    expect(parseJourneyBrowserSmokeOptions([])).toEqual({
      journeys: ['cold-start', 'first-token', 'long-session', 'session-switch'],
      extraRenders: 0,
      repeats: 1,
      outputPath: null,
      help: false,
    });
    expect(parseJourneyBrowserSmokeOptions(['--journey', 'cold-start']).journeys).toEqual(['cold-start']);
  });
});

describe('perf-journey gates:fast path scope', () => {
  it('composer / stream / trace / session paths select only their own journey slot plus baseline', () => {
    expect(selectTests(policy, ['src/renderer/components/features/chat/ChatInput/InputArea.tsx']).files)
      .toContain('tests/scripts/perfJourneyColdStart.test.ts');
    expect(selectTests(policy, ['src/renderer/components/features/chat/ChatInput/InputArea.tsx']).files)
      .not.toContain('tests/scripts/perfJourneyLongSession.test.ts');

    expect(selectTests(policy, ['src/renderer/hooks/useThrottledStreamingContent.ts']).files)
      .toContain('tests/scripts/perfJourneyFirstToken.test.ts');
  });

  it('unrelated host paths do not select any journey probe', () => {
    const prompt = selectTests(policy, ['src/host/prompts/old.ts']);
    for (const file of JOURNEY_FILES) expect(prompt.files).not.toContain(file);
    expect(prompt.matchedRules).not.toEqual(expect.arrayContaining([
      'perf-journey-cold-start',
      'perf-journey-first-token',
      'perf-journey-long-session',
      'perf-journey-session-switch',
    ]));
  });

  it('cron and permissions globs are outside every journey rule', () => {
    const journeyRules = policy.rules.filter((rule) => rule.id.startsWith('perf-journey-'));
    for (const file of ['src/host/cron/tick.ts', 'src/host/permissions/policyEngine.ts']) {
      for (const rule of journeyRules) {
        expect(rule.paths.some((pattern) => minimatch(file, pattern, { dot: true })), `${file} vs ${rule.id}`).toBe(false);
      }
    }
  });
});
