import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EvalRunEvent } from '../../src/shared/contract/evaluation';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'scripts', 'eval-ci.ts');
const tempDirs: string[] = [];

async function runJsonEval(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-json-events-'));
  tempDirs.push(dataDir);

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, evalScript, '--scope', 'smoke', '--json-events'],
      {
        cwd: repoRoot,
        env: { ...process.env, CODE_AGENT_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('eval-ci --json-events', () => {
  it('keeps stdout as a complete NDJSON run protocol and writes one report group', async () => {
    const result = await runJsonEval();
    const lines = result.stdout.trim().split('\n');
    const events = lines.map((line) => JSON.parse(line) as EvalRunEvent);

    expect(lines.length).toBeGreaterThan(2);
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(events[0]).toMatchObject({ type: 'run_start', schemaVersion: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'run_end', schemaVersion: 1 });
    expect(events.every((event) => event.runId === events[0].runId)).toBe(true);

    const runStart = events[0] as Extract<EvalRunEvent, { type: 'run_start' }>;
    const runEnd = events.at(-1) as Extract<EvalRunEvent, { type: 'run_end' }>;
    const caseEnds = events.filter(
      (event): event is Extract<EvalRunEvent, { type: 'case_end' }> => event.type === 'case_end',
    );
    expect(runStart.plannedCaseIds.length).toBeGreaterThan(0);
    expect(caseEnds).toHaveLength(runStart.plannedCaseIds.length);
    expect(caseEnds.every((event) => !('responses' in event) && !('toolExecutions' in event))).toBe(true);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(runEnd.exitCode).toBe(result.exitCode);
    expect(result.exitCode).toBe(0);

    expect(runEnd.reportFiles).toHaveLength(2);
    await Promise.all(runEnd.reportFiles.map((reportFile) => stat(reportFile)));
    const reportGroups = new Set(
      runEnd.reportFiles.map((reportFile) => path.basename(reportFile).replace(/\.(md|json)$/, '')),
    );
    expect(reportGroups.size).toBe(1);

    // Mutation guard: all paths share the one persistence choke point.
    const evalSource = await readFile(evalScript, 'utf8');
    expect(evalSource.match(/\bsaveReport\(/g)).toHaveLength(1);
  }, 120_000);
});
