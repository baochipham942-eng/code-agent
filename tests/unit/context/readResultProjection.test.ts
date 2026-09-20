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

/** Production native-subagent envelope: subagentExecutor.ts:958 + :1053. */
function flattenSubagentRead(status: 'Success' | 'Failed', body: string): string {
  return `Tool results:\nTool Read: ${status}\n${body}`;
}

function flattenedReadPair(firstContent: string, secondContent: string) {
  return [
    { role: 'assistant', content: '', toolCalls: [readCall('c1')] },
    { role: 'user', content: firstContent },
    { role: 'assistant', content: '', toolCalls: [readCall('c2')] },
    { role: 'user', content: secondContent },
  ];
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

  it('keeps changed and expanded reads visible', () => {
    const changed = structuredMessages(
      'Read version digest: changed\n  1\tnew',
      { limit: 4 },
      { digest: 'changed', shownRange: { startLine: 1, endLine: 4, totalLines: 4 } },
    );
    expect(projectReadResultsForModel(changed)[3].toolResults?.[0].output).toContain('changed');

    const expanded = structuredMessages(
      'Read version digest: abc123\n  1\talpha\n  2\tbeta\n  3\tgamma',
      { limit: 3 },
      { digest: 'abc123', shownRange: { startLine: 1, endLine: 3, totalLines: 3 } },
    );
    expect(projectReadResultsForModel(expanded)[3].toolResults?.[0].output).toContain('gamma');
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

  it('does not seed dedupe from archived Read placeholders', () => {
    const entries = [
      { role: 'assistant', content: '', toolCalls: [readCall('c1')] },
      { role: 'tool', content: '[TOOL_RESULT_ARCHIVED] Read 的完整输出已归档', toolCallId: 'c1' },
      { role: 'assistant', content: '', toolCalls: [readCall('c2')] },
      { role: 'tool', content: 'Read version digest: abc123\nfull content', toolCallId: 'c2' },
    ];
    const projected = projectReadTranscriptEntries(entries);
    expect(projected[3].content).toContain('full content');
  });

  it('does not seed dedupe from snipped Read placeholders that still carry digest metadata', () => {
    const entries = [
      { role: 'assistant', content: '', toolCalls: [readCall('c1')] },
      {
        role: 'tool',
        content: '[snipped: message compressed]',
        toolCallId: 'c1',
        toolResultMetadata: { digest: 'abc123', shownRange: { startLine: 1, endLine: 2, totalLines: 2 } },
      },
      { role: 'assistant', content: '', toolCalls: [readCall('c2')] },
      {
        role: 'tool',
        content: 'Read version digest: abc123\nfull content',
        toolCallId: 'c2',
        toolResultMetadata: { digest: 'abc123', shownRange: { startLine: 1, endLine: 2, totalLines: 2 } },
      },
    ];
    const projected = projectReadTranscriptEntries(entries);
    expect(projected[3].content).toBe('Read version digest: abc123\nfull content');
  });

  it('projects the flattened native-subagent pair without changing its tool call', () => {
    const output = flattenSubagentRead('Success', 'Read version digest: abc123\n  1\talpha\n  2\tbeta');
    const projected = projectReadSubagentMessages(flattenedReadPair(output, output));
    expect(projected[3].content).toContain('[Read already shown');
    expect(projected[3].content).toContain('digest=abc123');
    expect(projected[3].content).toContain('Tool results:');
    expect(projected[3].content).toContain('Tool Read: Success');
    expect(projected[2].toolCalls?.[0].id).toBe('c2');
  });

  it('does not replace a repeated flattened Read failure with a success receipt', () => {
    const failures = [
      flattenSubagentRead('Failed', 'File not found: /tmp/missing.ts'),
      'Tool results:\nError: Tool Read not available',
      'Tool results:\nTool Read: Error - EACCES: permission denied, open \'/tmp/secret.ts\'',
    ];
    for (const failed of failures) {
      const projected = projectReadSubagentMessages(flattenedReadPair(failed, failed));
      expect(projected[3].content).toBe(failed);
      expect(projected[3].content).not.toContain('[Read already shown');
    }
  });

  it('keeps a whitespace-only flattened reread visible after an indent-only Edit', () => {
    // Flattened Read output may omit a digest (legacy/provider). The fallback
    // fingerprint must keep indent-only edits visible instead of emitting a receipt.
    const before = flattenSubagentRead(
      'Success',
      '     1\tfunction f() {\n     2\t  return 1;\n     3\t}',
    );
    const after = flattenSubagentRead(
      'Success',
      '     1\tfunction f() {\n     2\t    return 1;\n     3\t}',
    );
    const projected = projectReadSubagentMessages(flattenedReadPair(before, after));
    expect(projected[3].content).toBe(after);
    expect(projected[3].content).toContain('    return 1;');
    expect(projected[3].content).not.toContain('[Read already shown');
  });
});
