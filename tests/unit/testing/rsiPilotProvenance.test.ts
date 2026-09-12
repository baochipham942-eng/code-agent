import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realRun, RSI_RUN_PROVENANCE_KEYS } from '../../../scripts/rsi-pilot/runner';
import { ARTIFACT_REPAIR_PROGRESS_MARKER, formatArtifactRepairProgress } from '../../../src/shared/constants/repair';

describe('rsi pilot provenance contract', () => {
  it('persists provenance on every run and summary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-prov-'));
    const casesPath = path.join(root, 'cases.json');
    await fs.writeFile(casesPath, JSON.stringify({ version: 1, note: '', cases: [{ id: 'x', subtype: 'runner', split: 'held_in', prompt: 'make x.html' }] }));
    const outDir = path.join(root, 'out');
    class StubAdapter {
      workingDirectory: string;
      constructor(config: any) { this.workingDirectory = config.workingDirectory; }
      async sendMessage() { await fs.writeFile(path.join(this.workingDirectory, 'x.html'), '<html></html>'); return { responses: [], toolExecutions: [], turnCount: 1, errors: [], repairRoundsUsed: 0 }; }
      async finalizeSession() {}
      getSessionId() { return undefined; }
    }
    await realRun({ casesPath, split: 'all', reps: 1, provider: 'longcat', model: 'stub-model', label: 'test', outDir, ids: undefined, rep: undefined, limit: 1 }, {
      StandaloneAgentAdapter: StubAdapter as any,
      validateGameArtifact: async () => ({ passed: true, failures: [] }),
      inferArtifactRepairIssueCodesFromText: () => [],
      getTelemetryCollector: () => ({ getSessionData: () => null }),
      gameValidationTimeouts: { RUNTIME_SMOKE_MS: 1, BROWSER_VISUAL_SMOKE_MS: 1, LIGHT_PLAYABILITY_SMOKE_MS: 1 },
    });
    const record = JSON.parse((await fs.readFile(path.join(outDir, 'runs.jsonl'), 'utf8')).trim());
    const summary = JSON.parse(await fs.readFile(path.join(outDir, 'summary.json'), 'utf8'));
    for (const key of RSI_RUN_PROVENANCE_KEYS) { expect(record.provenance[key]).toBeDefined(); expect(summary.provenance[key]).toBeDefined(); }
    expect(record.provenance.model).toBe('stub-model');
    expect(record.provenance.runnerSha).toMatch(/^[0-9a-f]{12}$/);
    expect(record.provenance.gitSha).not.toBe('unresolved');
  });

  it('repair progress text carries the marker the adapter counts repairRoundsUsed by', () => {
    expect(formatArtifactRepairProgress(1)).toContain(ARTIFACT_REPAIR_PROGRESS_MARKER);
    expect(formatArtifactRepairProgress(1)).toContain('第 1/4');
  });
});
