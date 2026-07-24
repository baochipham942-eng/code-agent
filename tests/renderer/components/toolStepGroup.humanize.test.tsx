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
});
