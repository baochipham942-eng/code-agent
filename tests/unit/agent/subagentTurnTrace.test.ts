import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import type { TurnDiffFileChange } from '../../../src/shared/contract/turnDiff';
import type { TraceEvent } from '../../../src/host/agent/runtime/turnTrace';
import { createSubagentTurnObservability } from '../../../src/host/agent/subagentTurnTrace';

// Fixture-side replay: join one run's trace ledger with its correlated lifecycle/diff events.
// Production has no delegation-card replay consumer yet (N-DELEGRECEIPT territory), so the
// contract lives with the fixture instead of as a dead production export.
interface SubagentTurnReplay {
  turnId: string;
  turnIndex: number;
  tools: Array<{ toolName: string; success: boolean; durationMs: number; error: string | null }>;
  files: TurnDiffFileChange[];
}

function replaySubagentTurns(input: {
  identity: { agentId: string; runId: string; parentToolUseId?: string };
  traceEvents: readonly TraceEvent[];
  agentEvents: readonly AgentEvent[];
}): SubagentTurnReplay[] {
  const belongsToRun = (event: AgentEvent): boolean => {
    const data = event.data as Record<string, unknown> | null | undefined;
    return Boolean(
      data
      && data.agentId === input.identity.agentId
      && data.runId === input.identity.runId
      && (input.identity.parentToolUseId === undefined || data.parentToolUseId === input.identity.parentToolUseId),
    );
  };
  const runEvents = input.agentEvents.filter(belongsToRun);
  const starts = runEvents.flatMap((event) => (
    event.type === 'turn_start' ? [{ turnId: event.data.turnId, turnIndex: event.data.iteration ?? 0 }] : []
  ));
  const diffsByTurn = new Map(runEvents.flatMap((event) => (
    event.type === 'turn_diff' ? [[event.data.turnId, event.data.files] as const] : []
  )));
  return starts.map(({ turnId, turnIndex }) => ({
    turnId,
    turnIndex,
    tools: input.traceEvents.flatMap((event) => (
      event.turnIndex === turnIndex && event.type === 'tool_dispatch'
        ? [{
            toolName: event.data.toolName,
            success: event.data.success,
            durationMs: event.data.durationMs,
            error: event.data.error,
          }]
        : []
    )),
    files: diffsByTurn.get(turnId) ?? [],
  }));
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('subagent turn trace and diff slots', () => {
  const tempDirs: string[] = [];
  const warn = () => {};

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRepo(): Promise<{ repoRoot: string; traceDir: string }> {
    const repo = await mkdtemp(join(tmpdir(), 'subagent-turn-diff-'));
    const traceDir = await mkdtemp(join(tmpdir(), 'subagent-turn-trace-'));
    tempDirs.push(repo, traceDir);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    return { repoRoot: await realpath(repo), traceDir };
  }

  it('keeps mutation path slots independent across concurrent agent runs', async () => {
    const { repoRoot, traceDir } = await makeRepo();
    const outputPath = join(repoRoot, 'first-run.txt');
    await writeFile(outputPath, 'hello\n', 'utf8');
    const events: AgentEvent[] = [];
    const port = { emit: (type: AgentEvent['type'], data: unknown) => events.push({ type, data } as AgentEvent) };
    const first = createSubagentTurnObservability({
      sessionId: 'session-parent', identity: { agentId: 'agent-1', runId: 'run-1' },
      events: port, workingDirectory: repoRoot, warn, traceDir,
    });
    const second = createSubagentTurnObservability({
      sessionId: 'session-parent', identity: { agentId: 'agent-2', runId: 'run-2' },
      events: port, workingDirectory: repoRoot, warn, traceDir,
    });

    const firstTurn = first.startTurn(1);
    const secondTurn = second.startTurn(1);
    await first.recordToolResult(
      { id: 'tool-1', name: 'Write', arguments: { file_path: outputPath, content: 'hello\n' } },
      { success: true }, 3,
    );
    await second.endTurn(secondTurn);
    await first.endTurn(firstTurn);

    const diffs = events.filter((event) => event.type === 'turn_diff');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ data: { turnId: firstTurn, agentId: 'agent-1', runId: 'run-1' } });
  });

  it('replays one delegated turn with its tool dispatch and 200-line disk diff', async () => {
    const { repoRoot, traceDir } = await makeRepo();
    const outputPath = join(repoRoot, 'generated.txt');
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(outputPath, content, 'utf8');

    const identity = { agentId: 'agent-writer', runId: 'run-writer', parentToolUseId: 'delegate-tool-1' };
    const agentEvents: AgentEvent[] = [];
    const observability = createSubagentTurnObservability({
      sessionId: 'session-parent',
      identity,
      events: { emit: (type, data) => agentEvents.push({ type, data } as AgentEvent) },
      workingDirectory: repoRoot,
      warn,
      traceDir,
    });

    const turnId = observability.startTurn(1);
    await observability.recordToolResult(
      { id: 'tool-write', name: 'Write', arguments: { file_path: outputPath, content } },
      { success: true }, 9,
    );
    await observability.endTurn(turnId);

    const turnDiff = agentEvents.find((event) => event.type === 'turn_diff');
    expect(turnDiff).toMatchObject({
      type: 'turn_diff',
      data: {
        turnId,
        agentId: 'agent-writer',
        runId: 'run-writer',
        parentToolUseId: 'delegate-tool-1',
        files: [{ filePath: outputPath, added: 200 }],
      },
    });

    const traceFiles = await listFilesRecursive(traceDir);
    expect(traceFiles).toHaveLength(1);
    const persisted = (await readFile(traceFiles[0], 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as TraceEvent);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ sessionId: 'session-parent', turnIndex: 1, type: 'tool_dispatch' });

    const replay = replaySubagentTurns({ identity, traceEvents: persisted, agentEvents });
    expect(replay).toEqual([{
      turnId,
      turnIndex: 1,
      tools: [{ toolName: 'Write', success: true, durationMs: 9, error: null }],
      files: [expect.objectContaining({ filePath: outputPath, added: 200 })],
    }]);
  });
});
