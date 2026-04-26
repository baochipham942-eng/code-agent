import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionDiffSummary } from '../../../src/renderer/components/features/chat/SessionDiffSummary';
import type { Message } from '../../../src/shared/contract/message';

const baseToolResult = {
  toolCallId: 'tc-1',
  success: true as const,
};

function makeEdit(filePath: string, oldText: string, newText: string, id = 'tc-edit'): Message {
  return {
    id: `m-${id}`,
    role: 'assistant',
    content: '',
    timestamp: 0,
    toolCalls: [
      {
        id,
        name: 'Edit',
        arguments: { file_path: filePath, old_string: oldText, new_string: newText },
        result: { ...baseToolResult, toolCallId: id, output: `Updated file: ${filePath}` },
      },
    ],
  };
}

function makeWrite(filePath: string, content: string, id = 'tc-write'): Message {
  return {
    id: `m-${id}`,
    role: 'assistant',
    content: '',
    timestamp: 0,
    toolCalls: [
      {
        id,
        name: 'Write',
        arguments: { file_path: filePath, content },
        result: { ...baseToolResult, toolCallId: id, output: `Created file: ${filePath}` },
      },
    ],
  };
}

describe('SessionDiffSummary', () => {
  it('renders nothing when no file write tools were called', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionDiffSummary, { messages: [] }),
    );
    expect(html).toBe('');
  });

  it('aggregates edits across messages and shows total counts', () => {
    const messages: Message[] = [
      makeWrite('/repo/a.ts', 'line1\nline2\nline3\n', 'w1'),
      makeEdit('/repo/b.ts', 'old\n', 'new1\nnew2\n', 'e1'),
      makeEdit('/repo/b.ts', 'foo\n', '', 'e2'),
    ];
    const html = renderToStaticMarkup(
      React.createElement(SessionDiffSummary, { messages }),
    );
    expect(html).toContain('2 files changed');
    expect(html).toContain('Review changes');
    // a.ts: 3 added, 0 removed (new file)
    // b.ts e1: +2 -1, e2: +0 -1 → +2 -2
    // total: +5 -2
    expect(html).toContain('+5');
    expect(html).toContain('-2');
  });

  it('skips failed tool calls', () => {
    const failed: Message = {
      id: 'm-fail',
      role: 'assistant',
      content: '',
      timestamp: 0,
      toolCalls: [
        {
          id: 'tc-fail',
          name: 'Edit',
          arguments: { file_path: '/repo/x.ts', old_string: 'a', new_string: 'b' },
          result: { toolCallId: 'tc-fail', success: false, error: 'permission denied' },
        },
      ],
    };
    const html = renderToStaticMarkup(
      React.createElement(SessionDiffSummary, { messages: [failed] }),
    );
    expect(html).toBe('');
  });

  it('marks brand new files with the new tag', () => {
    const messages: Message[] = [makeWrite('/repo/fresh.ts', 'console.log(1);\n', 'w1')];
    const html = renderToStaticMarkup(
      React.createElement(SessionDiffSummary, { messages }),
    );
    expect(html).toContain('1 file changed');
  });
});
