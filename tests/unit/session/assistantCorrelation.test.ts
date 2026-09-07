import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  attachAssistantCorrelation,
  stampAssistantMessageCorrelation,
  withTurnCorrelation,
} from '../../../src/host/session/assistantCorrelation';
import {
  createChildRunTraceContext,
  createRunTraceContext,
  withRunTraceContext,
} from '../../../src/host/telemetry/runTraceContext';

function runTrace(turnId?: string) {
  const run = createRunTraceContext({
    runId: 'run-1',
    sessionId: 'session-1',
    attempt: 1,
    ownerEpoch: 1,
    engine: 'native',
    workspace: '/tmp/correlation',
    processInstanceId: 'process-1',
  });
  return turnId ? createChildRunTraceContext(run, { turnId }) : run;
}

describe('assistantCorrelation', () => {
  it('keeps an existing correlation.turnId', () => {
    const metadata = { correlation: { turnId: 'already' } };
    expect(attachAssistantCorrelation(metadata, { turnId: 'other' })).toBe(metadata);
  });

  it('uses the explicit turnId when ALS is empty', () => {
    expect(attachAssistantCorrelation({ workbench: { workingDirectory: '/tmp' } }, { turnId: 'turn-x' }))
      .toMatchObject({
        workbench: { workingDirectory: '/tmp' },
        correlation: { turnId: 'turn-x' },
      });
  });

  it('fills from the active run-trace turn when no explicit turnId is given', () => {
    const turn = runTrace('turn-als');
    const result = withRunTraceContext(turn, () => attachAssistantCorrelation(undefined));
    expect(result).toMatchObject({
      correlation: { turnId: 'turn-als', traceId: turn.traceId },
    });
  });

  it('does not invent a key when neither explicit turnId nor ALS turnId exists', () => {
    expect(attachAssistantCorrelation({ source: 'typed' })).toEqual({ source: 'typed' });
    expect(attachAssistantCorrelation(undefined)).toBeUndefined();
  });

  it('stamps assistant messages in place and leaves other roles alone', () => {
    const assistant: Message = { id: 'a1', role: 'assistant', content: 'hi', timestamp: 1 };
    stampAssistantMessageCorrelation(assistant, { turnId: 'turn-stamp' });
    expect(assistant.metadata).toMatchObject({ correlation: { turnId: 'turn-stamp' } });

    const user: Message = { id: 'u1', role: 'user', content: 'hi', timestamp: 1 };
    stampAssistantMessageCorrelation(user, { turnId: 'turn-stamp' });
    expect(user.metadata).toBeUndefined();
  });

  it('withTurnCorrelation always returns a metadata object carrying the turnId', () => {
    expect(withTurnCorrelation(undefined, 'turn-cli')).toEqual({
      correlation: { turnId: 'turn-cli' },
    });
  });
});
