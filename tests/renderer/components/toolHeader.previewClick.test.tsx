// @vitest-environment jsdom
// ============================================================================
// E2 · 轮内明细「读取了 <路径>」行可点进右栏预览
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ToolCall } from '../../../src/shared/contract';

const openPreview = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (s: { openPreview: typeof openPreview }) => unknown) =>
    selector({ openPreview }),
}));
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';

function readCall(path: string): ToolCall {
  return {
    id: 'tc-read-1',
    name: 'Read',
    arguments: { file_path: path },
    result: {
      toolCallId: 'tc-read-1',
      success: true,
      output: 'file body',
    },
  } as ToolCall;
}

beforeEach(() => {
  openPreview.mockReset();
});

afterEach(cleanup);

describe('ToolHeader — Read path opens preview', () => {
  it('clicking the path control calls openPreview with the full path', () => {
    const path = '/Users/me/project/docs/report.md';
    render(<ToolHeader toolCall={readCall(path)} status="success" />);
    // 主行必须是人话，不能出现裸工具名
    expect(screen.getByText(/读取了/)).toBeTruthy();
    expect(screen.queryByText(/^Read$/)).toBeNull();

    const pathBtn = screen.getByTestId('tool-header-open-preview');
    fireEvent.click(pathBtn);
    expect(openPreview).toHaveBeenCalledWith(path);
  });

  it('TaskManager main line never shows the internal tool name', () => {
    const toolCall = {
      id: 'tc-tm',
      name: 'TaskManager',
      arguments: { action: 'list' },
    } as ToolCall;
    render(<ToolHeader toolCall={toolCall} status="success" />);
    expect(screen.getByText('更新了任务')).toBeTruthy();
    expect(screen.queryByText(/TaskManager/i)).toBeNull();
  });
});
