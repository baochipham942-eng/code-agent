// @vitest-environment jsdom
// N-EDIT-RETRY-KEY-SHAPE 返工：投影层标了 recovered 的 Edit 失败行必须真的在 UI 上降级——
// 没有「未成功」主文案、没有失败原因行，只剩一条安静的「后续修改已成功」脚注。
// 覆盖两层：ToolCallDisplay 的状态判定，以及 TraceNodeRenderer ToolCallNode 把
// node.toolCall.recovered 映射进 result.metadata 的接线（对齐 ToolStepGroup 的构造路径）。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    workingDirectory: '/repo',
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    useAppStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-1' }),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

// 注册表真实形状（multiEditSchema）：file_path + edits[]（old_text/new_text）。
const EDIT_ARGS = {
  file_path: '/tmp/report.md',
  edits: [{ old_text: '旧段落', new_text: '新段落' }],
};
const EDIT_ERROR = 'File must be read before editing';

function makeFailedEditToolCall(metadata?: Record<string, unknown>): ToolCall {
  return {
    id: 'edit-failed',
    name: 'Edit',
    arguments: EDIT_ARGS,
    result: { toolCallId: 'edit-failed', success: false, error: EDIT_ERROR, metadata },
  };
}

function makeEditNode(recovered: boolean, legacy = false): TraceNode {
  return {
    id: 'n-edit-failed',
    messageId: 'm1',
    type: 'tool_call',
    content: '',
    timestamp: 100,
    toolCall: {
      id: 'edit-failed',
      name: legacy ? 'edit_file' : 'Edit',
      args: legacy
        ? { file_path: '/tmp/report.md', old_string: '旧段落', new_string: '新段落' }
        : EDIT_ARGS,
      result: EDIT_ERROR,
      success: false,
      recovered,
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('ToolCallDisplay · recovered Edit row', () => {
  it('renders a quiet recovered footnote instead of the failed row once the retry succeeded', () => {
    const { container } = render(
      <ToolCallDisplay toolCall={makeFailedEditToolCall({ recovered: true })} index={0} total={1} />,
    );

    expect(container.textContent).not.toContain('未成功');
    expect(container.textContent).not.toContain('暂无失败原因摘要');
    const note = container.querySelector('[data-testid="tool-call-recovered-note"]');
    expect(note?.textContent).toBe('后续修改已成功');
  });

  it('keeps the failed headline and failure-reason line when the retry has not recovered it', () => {
    const { container } = render(
      <ToolCallDisplay toolCall={makeFailedEditToolCall()} index={0} total={1} />,
    );

    expect(container.textContent).toContain('未成功');
    expect(container.textContent).toContain('暂无失败原因摘要');
    expect(container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
    expect(container.textContent).not.toContain('后续修改已成功');
  });
});

describe('TraceNodeRenderer · recovered Edit node wiring', () => {
  it('passes node.toolCall.recovered through to the rendered row (registered edits[] shape)', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, { node: makeEditNode(true) }),
    );

    expect(html).not.toContain('未成功');
    expect(html).not.toContain('暂无失败原因摘要');
    expect(html).toContain('data-testid="tool-call-recovered-note"');
    expect(html).toContain('后续修改已成功');
  });

  it('still renders the failed row when the retry edited a different place', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, { node: makeEditNode(false) }),
    );

    expect(html).toContain('未成功');
    expect(html).not.toContain('tool-call-recovered-note');
  });

  it('demotes legacy flat edit_file-shaped recovered rows the same way', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, { node: makeEditNode(true, true) }),
    );

    expect(html).not.toContain('未成功');
    expect(html).toContain('data-testid="tool-call-recovered-note"');
    expect(html).toContain('后续修改已成功');
  });
});
