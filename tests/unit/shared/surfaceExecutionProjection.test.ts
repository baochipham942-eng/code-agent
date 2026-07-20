import { describe, expect, it } from 'vitest';
import { isSurfaceExecutionEventV1 } from '../../../src/shared/contract/surfaceExecution';
import { projectLegacyBrowserComputerResultToSurfaceEventV1 } from '../../../src/shared/utils/surfaceExecutionProjection';
import { redactSurfaceExecutionValue } from '../../../src/shared/utils/surfaceExecutionRedaction';

describe('legacy browser/computer Surface event projection', () => {
  it('keeps legacy identity and proof refs while projecting a readable browser event', () => {
    const event = projectLegacyBrowserComputerResultToSurfaceEventV1({
      eventId: 'trace-1',
      sequence: 7,
      sessionId: 'surface-session-1',
      runId: 'run-1',
      agentId: 'agent-a',
      toolName: 'browser_action',
      arguments: { action: 'screenshot', engine: 'managed' },
      result: {
        success: true,
        metadata: {
          browserComputerProof: {
            evidenceRefs: [{ id: 'evidence-shot-1' }],
          },
          browserComputerEvidenceCard: {
            status: 'observed',
            summary: 'Observed via analysis',
          },
        },
      },
      startedAt: 10,
      completedAt: 20,
    });

    expect(isSurfaceExecutionEventV1(event)).toBe(true);
    expect(event).toMatchObject({
      sequence: 7,
      sessionId: 'surface-session-1',
      runId: 'run-1',
      agentId: 'agent-a',
      surface: 'browser',
      phase: 'observe',
      status: 'succeeded',
      evidenceRefs: ['evidence-shot-1'],
      observation: { verdict: 'pass' },
    });
  });

  it('projects browser-scoped legacy computer actions onto the browser surface', () => {
    const event = projectLegacyBrowserComputerResultToSurfaceEventV1({
      eventId: 'trace-2',
      sequence: 1,
      sessionId: 'surface-session-2',
      runId: 'run-2',
      agentId: 'agent-b',
      toolName: 'computer_use',
      arguments: { action: 'smart_click', selector: '#save' },
      result: { success: true },
      startedAt: 10,
      completedAt: 20,
    });
    expect(event.surface).toBe('browser');
    expect(event.operation?.risk).toBe('browser_action');
  });

  it('redacts secret keys, inline credentials, and the canary before persistence', () => {
    const value = redactSurfaceExecutionValue({
      authToken: 'relay-token-raw',
      nested: {
        note: 'Authorization: Bearer abc.def and surface-secret-canary-do-not-leak',
        cookie: 'session=abc',
      },
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('relay-token-raw');
    expect(serialized).not.toContain('abc.def');
    expect(serialized).not.toContain('surface-secret-canary-do-not-leak');
    expect(serialized).not.toContain('session=abc');
  });
});
