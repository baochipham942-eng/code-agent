import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { TurnTraceRecorder } from '../../src/host/agent/runtime/turnTrace';

const mode = process.env.TURN_TRACE_BENCH_MODE ?? 'incremental';
const rounds = 9;
const eventCount = 24;
const workDelayMs = 20;
const root = await mkdtemp(path.join(os.tmpdir(), 'turn-trace-flush-bench-'));

try {
  await runRound(-1); // warm-up: filesystem/module initialization is not run overhead
  const durations: number[] = [];
  for (let round = 0; round < rounds; round += 1) durations.push(await runRound(round));
  durations.sort((a, b) => a - b);
  const report = {
    mode,
    eventCount,
    rounds,
    workDelayMsPerEvent: workDelayMs,
    medianRunMs: Number(durations[Math.floor(durations.length / 2)].toFixed(3)),
    minRunMs: Number(durations[0].toFixed(3)),
    maxRunMs: Number(durations.at(-1)!.toFixed(3)),
    samplesMs: durations.map((value) => Number(value.toFixed(3))),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runRound(round: number): Promise<number> {
  const sessionId = `bench-${mode}-${process.pid}-${round}`;
  const recorder = new TurnTraceRecorder(sessionId, root);
  const startedAt = performance.now();
  for (let index = 0; index < eventCount; index += 1) {
    recorder.record('tool_dispatch', {
      toolName: index % 2 === 0 ? 'Read' : 'Bash',
      success: true,
      durationMs: workDelayMs,
      error: null,
      fromCache: false,
    });
    await delay(workDelayMs);
  }
  recorder.flush();
  const durationMs = performance.now() - startedAt;
  const lines = (await readFile(path.join(root, `${sessionId}.jsonl`), 'utf8')).trim().split('\n');
  if (lines.length !== eventCount) throw new Error(`expected ${eventCount} events, got ${lines.length}`);
  return durationMs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
