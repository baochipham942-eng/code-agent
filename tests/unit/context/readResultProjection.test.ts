import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  projectReadResultsForModel,
  projectReadSubagentMessages,
  projectReadTranscriptEntries,
} from '../../../src/host/context/readResultProjection';

function readCall(id: string, offset = 1, limit = 2, extra: Record<string, unknown> = {}) {
  return { id, name: 'Read', arguments: { file_path: '/tmp/example.ts', offset, limit, ...extra } };
}

function structuredMessages(
  secondOutput: string,
  secondArgs: Record<string, unknown> = {},
  secondMetadata: Record<string, unknown> = { digest: 'abc123', shownRange: { startLine: 1, endLine: 2, totalLines: 2 } },
): Message[] {
  return [
    { id: 'a1', role: 'assistant', content: '', timestamp: 1, toolCalls: [readCall('c1')] },
    { id: 't1', role: 'tool', content: '', timestamp: 2, toolResults: [{
      toolCallId: 'c1', success: true, output: 'Read version digest: abc123\n  1\talpha\n  2\tbeta',
      metadata: { digest: 'abc123', shownRange: { startLine: 1, endLine: 2, totalLines: 2 } },
    }] },
    { id: 'a2', role: 'assistant', content: '', timestamp: 3, toolCalls: [readCall('c2', 1, 2, secondArgs)] },
    { id: 't2', role: 'tool', content: '', timestamp: 4, toolResults: [{
      toolCallId: 'c2', success: true, output: secondOutput,
      metadata: secondMetadata,
    }] },
  ];
}

describe('Read model-facing projection', () => {
  it('projects only the second same-range Read and leaves persisted results untouched', () => {
    const output = 'Read version digest: abc123\n  1\talpha\n  2\tbeta';
    const messages = structuredMessages(output);
    const projected = projectReadResultsForModel(messages);

    expect(projected[1].toolResults?.[0].output).toBe(output);
    expect(projected[3].toolResults?.[0].output).toContain('[Read already shown');
    expect(projected[3].toolResults?.[0].metadata).toEqual(expect.objectContaining({
      digest: 'abc123',
      shownRange: { startLine: 1, endLine: 2, totalLines: 2 },
    }));
    expect(messages[3].toolResults?.[0].output).toBe(output);
  });

  it('keeps changed, expanded, and forced reads visible', () => {
    const changed = structuredMessages(
      'Read version digest: changed\n  1\tnew',
      { limit: 4 },
      { digest: 'changed', shownRange: { startLine: 1, endLine: 4, totalLines: 4 } },
    );
    expect(projectReadResultsForModel(changed)[3].toolResults?.[0].output).toContain('changed');

    const forced = structuredMessages('Read version digest: abc123\n  1\talpha\n  2\tbeta', { force: true });
    expect(projectReadResultsForModel(forced)[3].toolResults?.[0].output).toContain('alpha');
  });

  it('does not treat a truncated prior result as the source for dedupe', () => {
    const entries = [
      { role: 'assistant', content: '', toolCalls: [readCall('c1')] },
      { role: 'tool', content: 'Read version digest: abc123\nold [truncated]', toolCallId: 'c1' },
      { role: 'assistant', content: '', toolCalls: [readCall('c2')] },
      { role: 'tool', content: 'Read version digest: abc123\nfull content', toolCallId: 'c2' },
    ];
    const projected = projectReadTranscriptEntries(entries);
    expect(projected[3].content).toContain('full content');
  });

  it('does not seed dedupe from compression markers with preserved key lines', () => {
    const entries = [
      { role: 'assistant', content: '', toolCalls: [readCall('c1')] },
      { role: 'tool', content: 'Read version digest: abc123\n...[truncated, 1 key line preserved]...', toolCallId: 'c1' },
      { role: 'assistant', content: '', toolCalls: [readCall('c2')] },
      { role: 'tool', content: 'Read version digest: abc123\nfull content', toolCallId: 'c2' },
    ];
    const projected = projectReadTranscriptEntries(entries);
    expect(projected[3].content).toContain('full content');
  });

  it('projects the flattened native-subagent pair without changing its tool call', () => {
    const messages = [
      { role: 'assistant', content: '', toolCalls: [readCall('c1')] },
      { role: 'user', content: 'Tool Read: Success\nalpha' },
      { role: 'assistant', content: '', toolCalls: [readCall('c2')] },
      { role: 'user', content: 'Tool Read: Success\nalpha' },
    ];
    const projected = projectReadSubagentMessages(messages);
    expect(projected[3].content).toContain('[Read already shown');
    expect(projected[2].toolCalls?.[0].id).toBe('c2');
  });
});
