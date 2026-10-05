import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

function checkoutNoteNode(skippedFiles: Array<{ filePath: string; reason: string; detail: string; toolName?: string }>): TraceNode {
  return {
    id: 'checkout-note-1',
    type: 'system',
    content: 'checkout note',
    timestamp: 100,
    metadata: {
      turnCheckoutNote: {
        operation: 'checkout',
        state: 'partial',
        done: ['conversation', 'note'],
        failed: [],
        skippedFiles,
        changedFileCount: 0,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      },
    },
  } as TraceNode;
}

// N-CHECKPOINT-MCP-WRITETARGET：未声明写盘披露的呈现。skippedFiles 里 reason
// 'undeclared_tool_write' 的行走新模板（{tool} 占位），MCP 全名 mcp__server__tool
// 显示成「server / tool」，解不动原样展示——不进 basename 剪切（键是合成串）。
describe('TraceNodeRenderer 回退披露 — 未声明工具写盘', () => {
  it('renders the undeclared-tool disclosure with the server / tool display name', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: checkoutNoteNode([{
          filePath: 'undeclared-tool:mcp__fs__save_file',
          reason: 'undeclared_tool_write',
          toolName: 'mcp__fs__save_file',
          detail: 'This tool\'s writes are not in the rollback scope.',
        }]),
      }),
    );

    expect(html).toContain('「fs / save_file」的写入不在回退范围内。');
    // 不把合成键当路径剪 basename，也不裸露 undeclared-tool: 前缀
    expect(html).not.toContain('undeclared-tool:');
    expect(html).not.toContain('save_file 的写入目标无法确定');
  });

  it('shows the raw name when the tool name is not a parsable mcp__server__tool triple', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: checkoutNoteNode([{
          filePath: 'undeclared-tool:legacy_tool',
          reason: 'undeclared_tool_write',
          toolName: 'legacy_tool',
          detail: 'This tool\'s writes are not in the rollback scope.',
        }]),
      }),
    );

    expect(html).toContain('「legacy_tool」的写入不在回退范围内。');
  });

  it('keeps the existing uncertain-target template for path-keyed disclosures', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: checkoutNoteNode([{
          filePath: 'uncertain-redirection:$OUT/a.txt',
          reason: 'uncertain_write_target',
          detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
        }]),
      }),
    );

    expect(html).toContain('uncertain-redirection:$OUT/a.txt 的写入目标无法确定，没有快照可回退。');
  });
});
