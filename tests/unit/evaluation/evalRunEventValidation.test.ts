import { describe, expect, it } from 'vitest';
import { parseEvalRunEvent } from '../../../src/host/evaluation/evalRunEventValidation';
import { EVAL_RUN_EVENT_SCHEMA_VERSION } from '../../../src/shared/contract/evaluation';

describe('evaluation run event validation', () => {
  it.each([
    ['skill_activated', 'name', 'docx'],
    ['memory_injected', 'id', 'user-memory'],
    ['subagent_spawned', 'id', 'agent-2'],
  ] as const)('accepts the %s protocol event', (type, field, value) => {
    expect(parseEvalRunEvent({
      schemaVersion: EVAL_RUN_EVENT_SCHEMA_VERSION,
      type,
      ts: 1,
      runId: 'run-1',
      testId: 'case-1',
      [field]: value,
    })).toMatchObject({ type, testId: 'case-1', [field]: value });
  });

  it('rejects old versions, unknown event types, and incomplete terminal summaries', () => {
    expect(() => parseEvalRunEvent({ schemaVersion: 1, type: 'error', ts: 1, runId: 'run-1', error: 'x' }))
      .toThrow(/版本/);
    expect(() => parseEvalRunEvent({ schemaVersion: 2, type: 'mystery', ts: 1, runId: 'run-1' }))
      .toThrow(/类型/);
    expect(() => parseEvalRunEvent({
      schemaVersion: 2,
      type: 'run_end',
      ts: 1,
      runId: 'run-1',
      summary: {},
      reportFiles: [],
      exitCode: 0,
      aborted: false,
    })).toThrow(/runId/);
  });
});
