import { describe, expect, it } from 'vitest';

import {
  DURABLE_RUN_SCHEMA_VERSION,
  RUN_STATUS_TRANSITIONS,
  assertRunEnvelope,
  canTransitionRunStatus,
  isTerminalRunStatus,
  type RunEnvelope,
} from '../../../src/shared/contract/durableRun';

function validEnvelope(overrides: Partial<RunEnvelope> = {}): RunEnvelope {
  return {
    schemaVersion: DURABLE_RUN_SCHEMA_VERSION,
    runId: 'run-1',
    sessionId: 'session-1',
    engine: { kind: 'native' },
    status: 'running',
    attempt: 1,
    cursor: { nextEventSeq: 4, checkpointSeq: 1 },
    createdAt: 1_000,
    updatedAt: 1_100,
    ...overrides,
  };
}

describe('Durable Run contract', () => {
  it('freezes the eight-state machine and terminal states', () => {
    expect(Object.keys(RUN_STATUS_TRANSITIONS)).toEqual([
      'created',
      'running',
      'waiting',
      'paused',
      'recovering',
      'completed',
      'failed',
      'cancelled',
    ]);

    expect(canTransitionRunStatus('created', 'running')).toBe(true);
    expect(canTransitionRunStatus('created', 'recovering')).toBe(true);
    expect(canTransitionRunStatus('running', 'waiting')).toBe(true);
    expect(canTransitionRunStatus('running', 'recovering')).toBe(true);
    expect(canTransitionRunStatus('waiting', 'recovering')).toBe(true);
    expect(canTransitionRunStatus('recovering', 'running')).toBe(true);
    expect(canTransitionRunStatus('completed', 'running')).toBe(false);
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
  });

  it('keeps logical run identity stable while attempts identify new process instances', () => {
    const original = validEnvelope({
      attempt: 1,
      owner: {
        ownerId: 'owner-1',
        processInstanceId: 'process-1',
        epoch: 1,
        leaseExpiresAt: 2_000,
      },
    });
    const recovered = validEnvelope({
      attempt: 2,
      status: 'recovering',
      owner: {
        ownerId: 'owner-2',
        processInstanceId: 'process-2',
        epoch: 2,
        leaseExpiresAt: 3_000,
      },
    });

    expect(recovered.runId).toBe(original.runId);
    expect(recovered.sessionId).toBe(original.sessionId);
    expect(recovered.attempt).toBe(original.attempt + 1);
    expect(recovered.owner?.processInstanceId).not.toBe(original.owner?.processInstanceId);
    expect(() => assertRunEnvelope(recovered)).not.toThrow();
  });

  it('rejects session identity reuse, invalid cursors, and incomplete terminal metadata', () => {
    expect(() => assertRunEnvelope(validEnvelope({ runId: 'session-1' }))).toThrow(/runId/);
    expect(() => assertRunEnvelope(validEnvelope({ cursor: { nextEventSeq: 0, checkpointSeq: 0 } }))).toThrow(/nextEventSeq/);
    expect(() => assertRunEnvelope(validEnvelope({ status: 'completed' }))).toThrow(/terminal/);
    expect(() => assertRunEnvelope(validEnvelope({
      status: 'completed',
      terminal: { status: 'failed', eventSeq: 4, at: 1_200 },
    }))).toThrow(/terminal status/);
    expect(() => assertRunEnvelope(validEnvelope({
      status: 'completed',
      terminal: { status: 'completed', eventSeq: 4, at: 1_200 },
      cursor: { nextEventSeq: 4, checkpointSeq: 1 },
    }))).toThrow(/eventSeq/);
  });

  it('does not complete while an operation or child run is unresolved', () => {
    expect(() => assertRunEnvelope(validEnvelope({
      status: 'completed',
      terminal: { status: 'completed', eventSeq: 3, at: 1_200 },
      pendingOperations: [{
        runId: 'run-1', operationId: 'op-1', attempt: 1, kind: 'tool_call', status: 'unknown',
        idempotencyKey: 'run-1:op-1', sideEffect: true, preparedAt: 1_050, updatedAt: 1_100,
      }],
    }))).toThrow(/unresolved operations/);
    expect(() => assertRunEnvelope(validEnvelope({
      status: 'completed',
      terminal: { status: 'completed', eventSeq: 3, at: 1_200 },
      childRuns: [{
        parentRunId: 'run-1', childRunId: 'run-child', relation: 'agent', status: 'running', createdAt: 1_050,
      }],
    }))).toThrow(/active child/);
  });
});
