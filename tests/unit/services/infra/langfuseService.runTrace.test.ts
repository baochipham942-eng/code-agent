import { describe, expect, it, vi } from 'vitest';
import { LangfuseService } from '../../../../src/host/services/infra/langfuseService';
import {
  createRunTraceContext,
  withRunTraceContext,
} from '../../../../src/host/telemetry/runTraceContext';

describe('LangfuseService RunTraceContext adapter', () => {
  it('uses the active OTel trace id, redacts content, and swallows exporter failures', () => {
    const traceSpan = { span: vi.fn(), generation: vi.fn(), event: vi.fn(), update: vi.fn() };
    const trace = vi.fn(() => traceSpan);
    const service = new LangfuseService();
    Object.assign(service as unknown as Record<string, unknown>, {
      enabled: true,
      client: { trace, score: vi.fn() },
    });
    const run = createRunTraceContext({
      runId: 'run-langfuse', sessionId: 'session-langfuse', attempt: 1, ownerEpoch: 1,
      engine: 'native', workspace: '/tmp/langfuse', processInstanceId: 'process-langfuse',
    });

    withRunTraceContext(run, () => service.startTrace('legacy-unrelated-id', {
      sessionId: run.sessionId,
      modelProvider: 'openai',
      modelName: 'gpt-test',
      runId: run.runId,
      attempt: run.attempt,
      ownerEpoch: run.ownerEpoch,
    }, 'secret prompt'));

    expect(trace).toHaveBeenCalledWith(expect.objectContaining({
      id: run.traceId,
      input: { length: 13, redacted: true },
      metadata: expect.objectContaining({
        runId: run.runId,
        attempt: 1,
        ownerEpoch: 1,
        workspaceFingerprint: run.workspaceFingerprint,
      }),
    }));
    expect(JSON.stringify(trace.mock.calls)).not.toContain('secret prompt');

    traceSpan.span.mockImplementationOnce(() => { throw new Error('exporter unavailable'); });
    expect(() => service.startSpan(run.traceId, 'span-id', {
      name: 'turn', input: { prompt: 'secret prompt' },
    })).not.toThrow();
  });
});
