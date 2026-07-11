import { beforeEach, describe, expect, it } from 'vitest';
import { TelemetryService, withApprovalTrace } from '../../../../src/host/telemetry/telemetryService';
import {
  createChildRunTraceContext,
  createRunTraceContext,
  withRunTraceContext,
} from '../../../../src/host/telemetry/runTraceContext';

function runContext(runId = 'run-1', attempt = 1) {
  return createRunTraceContext({
    runId,
    sessionId: 'session-1',
    attempt,
    ownerEpoch: attempt,
    engine: 'native',
    workspace: '/tmp/workspace',
    processInstanceId: `process-${attempt}`,
  });
}

describe('TelemetryService RunTraceContext authority', () => {
  let service: TelemetryService;

  beforeEach(() => {
    service = TelemetryService.getInstance();
    service.reset();
  });

  it('uses explicit/active run context and never a mutable process current trace', async () => {
    const runA = runContext('run-a');
    const runB = runContext('run-b');
    service.startRunAttemptSpan(runA);
    service.startRunAttemptSpan(runB);

    const [spanA, spanB] = await Promise.all([
      withRunTraceContext(runA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return service.startAgentSpan('turn-a', 'turn');
      }),
      withRunTraceContext(runB, async () => service.startAgentSpan('turn-b', 'turn')),
    ]);

    expect(spanA.traceId).toBe(runA.traceId);
    expect(spanA.parentSpanId).toBe(runA.spanId);
    expect(spanB.traceId).toBe(runB.traceId);
    expect(spanB.parentSpanId).toBe(runB.spanId);
  });

  it('records unique parallel child spans under their parent without prompt or arguments', () => {
    const parent = runContext();
    const childA = createChildRunTraceContext(parent, { agentId: 'agent-a' });
    const childB = createChildRunTraceContext(parent, { agentId: 'agent-b' });
    const spanA = service.startAgentSpan('agent-a', 'child', undefined, parent.spanId, childA);
    const spanB = service.startAgentSpan('agent-b', 'child', undefined, parent.spanId, childB);
    const tool = service.startToolSpan('Bash', { authorization: 'Bearer secret', prompt: 'secret' }, spanA.spanId);

    expect(spanA.spanId).not.toBe(spanB.spanId);
    expect(spanA.traceId).toBe(parent.traceId);
    expect(spanB.traceId).toBe(parent.traceId);
    expect(spanA.attributes).toMatchObject({
      'run.id': parent.runId,
      'run.attempt': parent.attempt,
      'agent.id': 'agent-a',
    });
    expect(JSON.stringify(tool.attributes)).not.toMatch(/Bearer secret|secret|authorization|prompt/i);
  });

  it('scrubs sensitive attributes added by events and terminal updates', () => {
    const span = service.startSpan('safe-boundary', 'internal');
    service.addSpanEvent(span.spanId, 'unsafe-event', {
      authorization: 'Bearer secret-event',
      'event.count': 1,
    });
    service.endSpan(span.spanId, 'error', {
      cookie: 'session=secret-cookie',
      prompt: 'secret prompt',
      'terminal.status': 'failed',
    });

    const completed = service.getRecentSpans(1)[0];
    expect(completed.attributes).toEqual({ 'terminal.status': 'failed' });
    expect(completed.events[0].attributes).toEqual({ 'event.count': 1 });
    expect(JSON.stringify(completed)).not.toMatch(/secret-event|secret-cookie|secret prompt/);
  });

  it('gives each background span an independent trace and exports terminal status', () => {
    const first = service.startHookSpan('startup', 'background');
    const second = service.startHookSpan('cleanup', 'background');
    service.endSpan(first.spanId, 'error', { 'terminal.status': 'timeout' });
    service.endSpan(second.spanId, 'cancelled');

    expect(first.traceId).not.toBe(second.traceId);
    const exported = JSON.parse(service.exportSpans()) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number } }> }> }>;
    };
    const statuses = exported.resourceSpans[0].scopeSpans[0].spans.map((span) => span.status.code);
    expect(statuses).toEqual([2, 2]);
  });

  it('records approval waiting and rejection without question or user input', async () => {
    const run = runContext('run-approval');
    await withRunTraceContext(run, () => withApprovalTrace('workflow_launch', async () => ({
      approved: false,
      feedback: 'secret user input',
    })));

    const approval = service.getRecentSpans(5).find((span) => span.kind === 'approval')!;
    expect(approval.status).toBe('cancelled');
    expect(approval.events.map((event) => event.name)).toEqual([
      'approval.waiting',
      'approval.rejected',
    ]);
    expect(JSON.stringify(approval)).not.toContain('secret user input');
  });
});
