import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realRun } from '../../../scripts/rsi-pilot/runner';

const SESSION = { totalInputTokens: 1200, totalOutputTokens: 300, totalTokens: 1500, estimatedCost: 0.55 };
const EXPECTED = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, estimatedCost: 0.55 };

type Mode = 'hang' | 'throw' | 'success';

async function runUnit(mode: Mode, sessionData: typeof SESSION | null, opts: { advance?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-tok-'));
  const casesPath = path.join(root, 'cases.json');
  await fs.writeFile(casesPath, JSON.stringify({ version: 1, note: '', cases: [{ id: 'x', subtype: 'runner', split: 'held_in', prompt: 'make x.html' }] }));
  const outDir = path.join(root, 'out');
  let started!: () => void;
  const sendStarted = new Promise<void>((r) => { started = r; });
  class StubAdapter {
    workingDirectory: string;
    constructor(config: any) { this.workingDirectory = config.workingDirectory; }
    async sendMessage() {
      started();
      if (mode === 'hang') return new Promise<never>(() => {});
      if (mode === 'throw') throw new Error('boom');
      await fs.writeFile(path.join(this.workingDirectory, 'x.html'), '<html></html>');
      return { responses: [], toolExecutions: [], turnCount: 1, errors: [], repairRoundsUsed: 0 };
    }
    async cancelActiveRun() {}
    async finalizeSession() {}
    getSessionId() { return 'sess-1'; }
  }
  const done = realRun({ casesPath, split: 'all', reps: 1, provider: 'longcat', model: 'stub-model', label: 'test', outDir, ids: undefined, rep: undefined, limit: 1 }, {
    StandaloneAgentAdapter: StubAdapter as any,
    validateGameArtifact: async () => ({ passed: true, failures: [] }),
    inferArtifactRepairIssueCodesFromText: () => [],
    getTelemetryCollector: () => ({ getSessionData: () => sessionData }),
    gameValidationTimeouts: { RUNTIME_SMOKE_MS: 1, BROWSER_VISUAL_SMOKE_MS: 1, LIGHT_PLAYABILITY_SMOKE_MS: 1 },
    HARNESS_KNOB_DEFAULTS: {},
    ensureEvalDatabase: async () => {},
  } as any);
  if (opts.advance) {
    await sendStarted;
    await vi.advanceTimersByTimeAsync(600_001);
  }
  await done;
  return JSON.parse((await fs.readFile(path.join(outDir, 'runs.jsonl'), 'utf8')).trim());
}

describe('rsi pilot runner records tokenUsage on every path', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('timed-out unit keeps the telemetry spend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const record = await runUnit('hang', SESSION, { advance: true });
    expect(record.timedOut).toBe(true);
    expect(record.tokenUsage).toEqual(EXPECTED);
  });

  it('errored unit keeps the telemetry spend', async () => {
    const record = await runUnit('throw', SESSION);
    expect(record.timedOut).toBeUndefined();
    expect(record.error).toBe('boom');
    expect(record.tokenUsage).toEqual(EXPECTED);
  });

  it('no telemetry data → tokenUsage null, no throw', async () => {
    const record = await runUnit('throw', null);
    expect(record.error).toBe('boom');
    expect(record.tokenUsage).toBeNull();
  });

  it('success path unchanged', async () => {
    const record = await runUnit('success', SESSION);
    expect(record.error).toBeNull();
    expect(record.tokenUsage).toEqual(EXPECTED);
  });
});
