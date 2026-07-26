import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '@shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

function readNode(): TraceNode {
  return {
    id: 'tool-1',
    messageId: 'msg-1',
    type: 'tool_call',
    content: '',
    timestamp: Date.now(),
    toolCall: {
      id: 'tool-1',
      name: 'Read',
      args: { file_path: '/Users/me/project/docs/report.md' },
      result: 'file contents…',
      success: true,
      duration: 40,
    },
  };
}

function failedWriteNode(): TraceNode {
  return {
    id: 'tool-w1',
    messageId: 'msg-1',
    type: 'tool_call',
    content: '',
    timestamp: Date.now(),
    toolCall: {
      id: 'tool-w1',
      name: 'Write',
      args: { file_path: '/Users/me/work/test3.txt' },
      result: 'Artifact validation failed for /Users/me/work/test3.txt.',
      success: false,
      duration: 12,
    },
  };
}

describe('ToolStepGroup — humanized step text', () => {
  it('shows a humanized Chinese sentence in the collapsed step row', () => {
    const html = renderToStaticMarkup(React.createElement(ToolStepGroup, { nodes: [readNode()] }));
    expect(html).toContain('读取了 .../docs/report.md');
  });

  it('keeps the original tool name and path visible in the expanded detail', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes: [readNode()], defaultExpanded: true }),
    );
    // Step row still shows the humanized sentence…
    expect(html).toContain('读取了 .../docs/report.md');
    // …while the expanded detail keeps the raw tool name and file path (info not dropped).
    expect(html).toContain('Read');
    expect(html).toContain('report.md');
  });

  // 失败工具的步骤行不能再出现「写入了」这种过去时肯定式——它会和状态词
  // 「写入失败」同屏自相矛盾（实锤症状：● 写入失败 + 写入了 …/work/test3.txt）。
  it('failed write step shows intent phrasing, never a past-tense claim', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes: [failedWriteNode()] }),
    );
    expect(html).toContain('写入 .../work/test3.txt');
    expect(html).not.toContain('写入了');
  });

  it('failed write step keeps intent phrasing in the expanded detail too', () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolStepGroup, { nodes: [failedWriteNode()], defaultExpanded: true }),
    );
    expect(html).not.toContain('写入了');
  });
});
