// Jev compaction must inherit the fresh-tool-result protection set: results the
// model has not observed yet (after the last assistant message) are passed into
// applyJevCompaction as protected, so they are never dropped or truncated.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const applyJevCompactionMock = vi.hoisted(() =>
  vi.fn(async (_transcript: unknown, _systemOne?: unknown, _options?: { protectedMessageIds: Set<string> }) =>
    ({ skipped: true, reason: 'unavailable' })),
);

vi.mock('../../../src/host/context/jevCompaction', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/context/jevCompaction')>();
  return {
    ...original,
    isJevCompactionEnabled: () => true,
    applyJevCompaction: applyJevCompactionMock as unknown as typeof original.applyJevCompaction,
  };
});

import { CompressionPipeline, type PipelineConfig } from '../../../src/host/context/compressionPipeline';
import { CompressionState } from '../../../src/host/context/compressionState';
import { type ProjectableMessage } from '../../../src/host/context/projectionEngine';

function makeMsg(id: string, role: string, content: string, turnIndex = 0): ProjectableMessage {
  return { id, role, content, turnIndex };
}

function makeText(targetTokens: number): string {
  return 'word '.repeat(targetTokens);
}

const BASE_CONFIG: PipelineConfig = {
  maxTokens: 10000,
  currentTurnIndex: 20,
  isMainThread: true,
  cacheHot: false,
  idleMinutes: 0,
  enableSnip: true,
  enableMicrocompact: true,
  enableContextCollapse: true,
  toolResultBudget: 2000,
};

describe('CompressionPipeline Jev compaction protection set', () => {
  beforeEach(() => {
    applyJevCompactionMock.mockClear();
  });

  it('passes fresh (model-unobserved) tool results as protected into applyJevCompaction', async () => {
    const pipeline = new CompressionPipeline();
    const state = new CompressionState();
    // Push usage past the 75% context-collapse threshold, with >6 tool results
    // so the positional pin alone cannot cover the fresh ones.
    const transcript: ProjectableMessage[] = [
      makeMsg('u1', 'user', makeText(8000)),
      makeMsg('a1', 'assistant', 'working'),
      makeMsg('c0', 'assistant', makeText(50)),
    ];
    // One assistant turn emitting 8 tool results: all are fresh (after the last
    // assistant message), but the positional pin-6 can only cover t2..t7.
    for (let i = 0; i < 8; i += 1) {
      transcript.push(makeMsg(`t${i}`, 'tool', makeText(50)));
    }

    await pipeline.evaluate(transcript, state, BASE_CONFIG);

    expect(applyJevCompactionMock).toHaveBeenCalledTimes(1);
    const options = applyJevCompactionMock.mock.calls[0][2] as unknown as { protectedMessageIds: Set<string> };
    // t0/t1 are fresh yet beyond the pin-6 window — only the inherited
    // fresh-result protection keeps them safe.
    expect(options.protectedMessageIds.has('t0')).toBe(true);
    expect(options.protectedMessageIds.has('t1')).toBe(true);
    expect(options.protectedMessageIds.has('t7')).toBe(true);
  });

  it('still passes user-pinned interventions through in the same set', async () => {
    const pipeline = new CompressionPipeline();
    const state = new CompressionState();
    const transcript: ProjectableMessage[] = [
      makeMsg('u1', 'user', makeText(8000)),
      makeMsg('a1', 'assistant', 'working'),
      makeMsg('t-old', 'tool', makeText(50)),
      makeMsg('c9', 'assistant', makeText(50)),
      makeMsg('t9', 'tool', makeText(50)),
    ];

    await pipeline.evaluate(transcript, state, {
      ...BASE_CONFIG,
      interventions: { pinned: ['t-old'], retained: [], excluded: [] } as never,
    });

    expect(applyJevCompactionMock).toHaveBeenCalledTimes(1);
    const options = applyJevCompactionMock.mock.calls[0][2] as unknown as { protectedMessageIds: Set<string> };
    expect(options.protectedMessageIds.has('t-old')).toBe(true);
    expect(options.protectedMessageIds.has('t9')).toBe(true);
  });
});
