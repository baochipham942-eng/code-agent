import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyJevCompaction,
} from '../../../src/host/context/jevCompaction';
import type { JevSystemOneCall } from '../../../src/shared/constants/jevQuestions';
import type { ProjectableMessage } from '../../../src/host/context/projectionEngine';

function toolTranscript(): ProjectableMessage[] {
  const messages: ProjectableMessage[] = [];
  for (let index = 0; index < 8; index++) {
    messages.push({
      id: `call-${index}`,
      role: 'assistant',
      content: `call ${index}`,
      toolCalls: [{ id: `tool-${index}`, name: 'Read' }],
    });
    messages.push({
      id: `result-${index}`,
      role: 'tool',
      content: `result ${index} ${'x'.repeat(500)}`,
      toolCallId: `tool-${index}`,
    });
  }
  return messages;
}

describe('jevCompaction', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('is default off and does not mutate the transcript', async () => {
    const messages = toolTranscript();
    const before = messages.map((message) => message.content);
    const systemOne = vi.fn() as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result).toMatchObject({ skipped: true, reason: 'disabled' });
    expect(messages.map((message) => message.content)).toEqual(before);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('pins the latest six entries, drops neither pair nor orphan, and truncates result only', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    let capturedState: Record<string, unknown> | undefined;
    const systemOne = vi.fn(async (state: Record<string, unknown>, questions: Record<string, unknown>) => {
      capturedState = state;
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) {
        const entryKey = key.replace(/^keep_(?:call|result)_/, '');
        const entry = (state.entries as Record<string, { kind: string }>)[entryKey];
        const isCall0 = entryKey.includes('call-0');
        const isCall1Result = entryKey.includes('result-1');
        answers[key] = { noul: isCall0 ? 0.1 : isCall1Result ? 0.1 : 0.9 };
        if (entry?.kind === 'call' && isCall1Result) answers[key] = { noul: 0.9 };
      }
      return answers;
    }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result.skipped).toBe(false);
    expect(result.droppedMessages).toBe(2);
    expect(result.truncatedResults).toBe(1);
    expect(messages.some((message) => message.id === 'call-0')).toBe(false);
    expect(messages.some((message) => message.id === 'result-0')).toBe(false);
    expect(messages.find((message) => message.id === 'result-1')?.content.length).toBe(300);
    expect(messages.find((message) => message.id === 'call-7')).toBeTruthy();
    expect(capturedState && Array.isArray(capturedState.entries)).toBe(false);
    expect(result.spotCheckPassed).toBe(true);
  });

  it('fails closed when Jev is unavailable', async () => {
    vi.stubEnv('CODE_AGENT_JEV_COMPACTION', '1');
    const messages = toolTranscript();
    const before = messages.length;
    const systemOne = vi.fn(async () => { throw new Error('jev down'); }) as unknown as JevSystemOneCall;
    const result = await applyJevCompaction(messages, systemOne);
    expect(result).toMatchObject({ skipped: true, reason: 'unavailable' });
    expect(messages.length).toBe(before);
  });
});
