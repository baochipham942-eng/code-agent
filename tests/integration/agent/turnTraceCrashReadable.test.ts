import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { TraceReadService } from '../../../src/host/app/traceReadService';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const workerEntry = path.join(repoRoot, 'tests/fixtures/turnTraceCrashWorker.ts');
const roots: string[] = [];
type CrashWorker = ChildProcessByStdio<null, Readable, Readable>;
const children: CrashWorker[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('turn trace crash readability', () => {
  it('keeps in-turn inference/tool events readable after SIGKILL and skips a partial final line', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'code-agent-turntrace-crash-'));
    roots.push(dataDir);
    const sessionId = `session-crash-${process.pid}`;
    const child = spawn(process.execPath, [tsxCli, workerEntry, dataDir, sessionId], {
      cwd: repoRoot,
      env: { ...process.env, CODE_AGENT_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    await waitForMarker(child, 'incremental-flush-complete');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const tracePath = path.join(dataDir, 'traces', `${sessionId}.jsonl`);
    const persisted = readFileSync(tracePath, 'utf8');
    expect(persisted).toContain('"type":"inference"');
    expect(persisted).toContain('"type":"tool_dispatch"');
    expect(persisted).not.toContain('"type":"turn_outcome"');

    appendFileSync(tracePath, '{"type":"inference","data":', 'utf8');
    const read = await new TraceReadService(dataDir).readSession(sessionId);
    expect(read.events.some((event) => event.type === 'inference')).toBe(true);
    expect(read.events.some((event) => event.type === 'tool_dispatch')).toBe(true);
    expect(read.skippedLines).toBe(1);
  });
});

async function waitForMarker(child: CrashWorker, marker: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`worker marker timeout; stderr=${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(`"marker":"${marker}"`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`worker exited before marker: code=${code} signal=${signal}; stderr=${stderr}`));
    });
  });
}
