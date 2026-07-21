import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  exportToJson,
  exportToMarkdown,
} from '../../../src/renderer/components/features/export/ExportModal';

function messages(): Message[] {
  const metadata = {
    surfaceExecutionSessionV1: {
      version: 1,
      sessionId: 'surface-renderer-export',
      runId: 'run-renderer-export',
      conversationId: 'conversation-renderer-export',
      agentId: 'agent-renderer-export',
      surface: 'browser',
      provider: 'managed',
      state: 'completed',
      grantId: 'grant-renderer-secret',
      startedAt: 100,
      heartbeatAt: 150,
    },
    surfaceExecutionEventsV1: [{
      version: 1,
      eventId: 'event-renderer-export',
      sequence: 1,
      sessionId: 'surface-renderer-export',
      runId: 'run-renderer-export',
      agentId: 'agent-renderer-export',
      surface: 'browser',
      provider: 'managed',
      sessionState: 'completed',
      phase: 'artifact',
      status: 'succeeded',
      userSummary: '网站产物已生成并完成复验',
      operation: { action: 'navigate', risk: 'read' },
      observation: { verdict: 'pass', findings: ['首页四个板块完整'] },
      evidenceRefs: ['evidence-renderer'],
      evidence: [{
        version: 1,
        evidenceId: 'evidence-renderer',
        kind: 'screenshot',
        source: 'browser',
        title: '最终页面截图',
        capturedAt: 140,
        redactionStatus: 'clean',
        inspection: {
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'verified',
          inspectedBy: { kind: 'agent', id: 'vision', method: 'vision' },
          inspectedAt: 145,
          supportsStepIds: ['step-final'],
          checklist: [{ id: 'layout', label: '四板块完整', status: 'passed' }],
        },
      }],
      artifactRefs: ['artifact:site.html'],
      availableControls: ['end_session'],
      startedAt: 120,
      completedAt: 150,
    }],
    selector: '#private-selector',
    token: 'surface-secret-canary-renderer',
  };

  return [{
    id: 'assistant-renderer-export',
    role: 'assistant',
    content: '网站已完成。',
    timestamp: 150,
    reasoning: 'private chain of thought must not be exported',
    thinking: 'hidden internal reasoning must not be exported',
    toolCalls: [{
      id: 'tool-renderer-export',
      name: 'browser_action',
      arguments: {
        action: 'navigate',
        selector: '#private-selector',
        text: 'surface-secret-canary-input',
      },
      result: {
        toolCallId: 'tool-renderer-export',
        success: true,
        output: 'surface-secret-canary-output',
        metadata,
      },
    }],
  }];
}

describe('ExportModal Surface Execution projection', () => {
  it('exports semantic Markdown without raw Surface JSON, selector, or reasoning', () => {
    const markdown = exportToMarkdown('Surface session', messages());

    expect(markdown).toContain('## Surface Execution');
    expect(markdown).toContain('artifact · succeeded · 网站产物已生成并完成复验');
    expect(markdown).toContain('verification=verified');
    expect(markdown).toContain('Outputs: artifact:site.html');
    expect(markdown).not.toContain('surfaceExecutionSessionV1');
    expect(markdown).not.toContain('#private-selector');
    expect(markdown).not.toContain('grant-renderer-secret');
    expect(markdown).not.toContain('surface-secret-canary');
    expect(markdown).not.toContain('private chain of thought');
    expect(markdown).not.toContain('hidden internal reasoning');
  });

  it('exports JSON with an additive safe projection and no raw reasoning', () => {
    const json = exportToJson('Surface session', messages());
    const parsed = JSON.parse(json) as {
      surfaceExecution: { sessions: Array<{ events: Array<Record<string, unknown>> }> };
      messages: Array<{
        reasoning?: string;
        toolCalls: Array<{ arguments: Record<string, unknown> }>;
      }>;
    };

    expect(parsed.surfaceExecution.sessions[0].events[0]).toMatchObject({
      phase: 'artifact',
      status: 'succeeded',
      observation: { verdict: 'pass' },
      artifactRefs: ['artifact:site.html'],
    });
    expect(parsed.messages[0].toolCalls[0].arguments).toEqual({ action: 'navigate' });
    expect(parsed.messages[0].reasoning).toBeUndefined();
    expect(json).not.toContain('surfaceExecutionSessionV1');
    expect(json).not.toContain('#private-selector');
    expect(json).not.toContain('grant-renderer-secret');
    expect(json).not.toContain('surface-secret-canary');
    expect(json).not.toContain('private chain of thought');
    expect(json).not.toContain('hidden internal reasoning');
  });

  it('keeps legacy Browser arguments compatible after applying existing redaction', () => {
    const json = exportToJson('Legacy Browser session', [{
      id: 'legacy-message',
      role: 'assistant',
      content: 'Legacy result',
      timestamp: 150,
      toolCalls: [{
        id: 'legacy-tool',
        name: 'browser_action',
        arguments: { action: 'type', selector: '#email', text: 'secret@example.com' },
      }],
    }]);
    const parsed = JSON.parse(json) as {
      messages: Array<{ toolCalls: Array<{ arguments: Record<string, unknown> }> }>;
    };

    expect(parsed.messages[0].toolCalls[0].arguments).toMatchObject({
      action: 'type',
      selector: '#email',
    });
    expect(json).not.toContain('secret@example.com');
  });
});
