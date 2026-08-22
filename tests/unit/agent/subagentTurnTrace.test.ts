import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import {
  buildSubagentTurnReplay,
  createSubagentMutationPathSlot,
  createSubagentTurnTraceRecorder,
  emitSubagentTurnDiff,
  getSubagentTraceFileKey,
  recordSubagentMutationPaths,
} from '../../../src/host/agent/subagentTurnTrace';

describe('subagent turn trace and diff slots', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('replays one delegated turn with its tool dispatch and 200-line disk diff', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'subagent-turn-diff-'));
    const traceDir = await mkdtemp(join(tmpdir(), 'subagent-turn-trace-'));
    tempDirs.push(repo, traceDir);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const repoRoot = await realpath(repo);
    const outputPath = join(repoRoot, 'generated.txt');
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(outputPath, content, 'utf8');

    const identity = {
      agentId: 'agent-writer',
      runId: 'run-writer',
      parentToolUseId: 'delegate-tool-1',
    };
    const parentMutationPaths = new Set<string>();
    const runMutationPaths = createSubagentMutationPathSlot();
    await recordSubagentMutationPaths({
      toolCall: { name: 'Write', arguments: { file_path: outputPath, content } },
      success: true,
      workingDirectory: repoRoot,
      modifiedPaths: runMutationPaths,
    });

    const recorder = createSubagentTurnTraceRecorder({
      sessionId: 'session-parent',
      identity,
      traceDir,
    });
    recorder.setTurn(1);
    recorder.record('tool_dispatch', {
      toolName: 'Write',
      success: true,
      durationMs: 9,
      error: null,
      fromCache: false,
    });
    expect(recorder.flush()).toBe(true);

    const agentEvents: AgentEvent[] = [{
      type: 'turn_start',
      data: { turnId: 'subagent-turn-1', iteration: 1, ...identity },
    }];
    const emitted = await emitSubagentTurnDiff({
      events: { emit: (type, data) => agentEvents.push({ type, data } as AgentEvent) },
      identity,
      workingDirectory: repoRoot,
      turnId: 'subagent-turn-1',
      modifiedPaths: runMutationPaths,
    });

    expect(emitted).toBe(true);
    const turnDiff = agentEvents.find((event) => event.type === 'turn_diff');
    expect(turnDiff).toMatchObject({
      type: 'turn_diff',
      data: {
        turnId: 'subagent-turn-1',
        agentId: 'agent-writer',
        runId: 'run-writer',
        parentToolUseId: 'delegate-tool-1',
        files: [{ filePath: outputPath, added: 200 }],
      },
    });
    expect(parentMutationPaths).not.toContain(outputPath);

    const replay = buildSubagentTurnReplay({
      identity,
      traceEvents: recorder.getEvents(),
      agentEvents,
    });
    expect(replay).toEqual([{
      turnId: 'subagent-turn-1',
      turnIndex: 1,
      tools: [{ toolName: 'Write', success: true, durationMs: 9, error: null }],
      files: [expect.objectContaining({ filePath: outputPath, added: 200 })],
    }]);

    const traceFile = join(traceDir, `${getSubagentTraceFileKey('session-parent', identity)}.jsonl`);
    const persisted = (await readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sessionId: 'session-parent',
      turnIndex: 1,
      type: 'tool_dispatch',
    });
  });
});
