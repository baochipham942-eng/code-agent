// @vitest-environment jsdom
// ============================================================================
// TurnDiffHunkFeedback（经 TurnDiffSummary 全链路）：
// - 权威 diff 展开后列出改动块，行号/计数来自 buildTurnDiffHunks
// - 评论 → 一句话 → 回车：sendPrompt 恰好一次，消息是 builder 对该块的真实输出，
//   且不带 localityAnchor（代码行没有产物坐标，host guard 不该收到锚点）
// - 发出后输入行清空收起
// - 非权威 diff（工具 args 片段回退）没有块级反馈入口——行号不是文件行号
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  sendPrompt: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: mocks.invoke,
    invokeDomain: mocks.invokeDomain,
  },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
// CodeMerge 视图与块级反馈无关，jsdom 里跑 CodeMirror 只添噪声
vi.mock('../../../src/renderer/components/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view-stub" />,
}));

import { TurnDiffSummary } from '../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary';
import { buildDiffHunkFeedbackMessage } from '../../../src/shared/livePreview/localityFeedback';
import { clearTurnDiffExpansionForTests } from '../../../src/renderer/utils/turnDiffExpansionState';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';

const OLD_TEXT = 'a\nb\nc\nd\ne\n';
const NEW_TEXT = 'a\nB\nc\nd\ne\nf\n';

function makeAuthoritativeTurn(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-hunk',
    status: 'completed',
    startTime: 100,
    nodes: [],
    turnDiff: {
      turnId: 'turn-hunk',
      filesAuthoritative: true,
      files: [
        {
          filePath: '/tmp/example.ts',
          oldText: OLD_TEXT,
          newText: NEW_TEXT,
          added: 2,
          removed: 1,
          isNewFile: false,
          editCount: 1,
        },
      ],
    },
  } as TraceTurn;
}

/** 非权威：缺文件通告 + 工具 args 回退，卡片从片段反推，行号不是文件行号。 */
function makeNonAuthoritativeTurn(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-hunk-fallback',
    status: 'completed',
    startTime: 100,
    turnDiff: {
      turnId: 'turn-hunk-fallback',
      filesAuthoritative: false,
      files: [],
      missingFiles: ['/tmp/other.ts'],
    },
    nodes: [
      {
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 150,
        toolCall: {
          id: 'tool-1',
          name: 'Edit',
          args: { file_path: '/tmp/example.ts', old_string: 'b', new_string: 'B' },
          result: 'Updated file: /tmp/example.ts',
          success: true,
        },
      },
    ],
  } as TraceTurn;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invokeDomain.mockReset();
  mocks.sendPrompt.mockReset().mockResolvedValue(undefined);
  clearTurnDiffExpansionForTests();
  useSessionStore.setState({ currentSessionId: 'session-1' });
  useMessageActionStore.setState({
    sendPrompt: mocks.sendPrompt as unknown as ReturnType<typeof useMessageActionStore.getState>['sendPrompt'],
  });
});

afterEach(cleanup);

const expandBtn = () => screen.getByRole('button', { name: /展开改动|收起改动|Expand diff|Collapse diff/i });

describe('TurnDiffHunkFeedback（改动卡块级反馈）', () => {
  it('权威 diff 展开后列出改动块：块序号 + 新文件行号 + 增删计数', () => {
    render(<TurnDiffSummary turn={makeAuthoritativeTurn()} />);
    fireEvent.click(expandBtn());

    expect(screen.getByTestId('turn-diff-hunk-list')).toBeTruthy();
    const commentBtns = screen.getAllByTestId('hunk-comment-btn');
    expect(commentBtns).toHaveLength(2); // 块1: b→B；块2: 追加 f
    expect(screen.getByText('块 1')).toBeTruthy();
    expect(screen.getByText('第 2 行')).toBeTruthy();
    expect(screen.getByText('块 2')).toBeTruthy();
    expect(screen.getByText('第 6 行')).toBeTruthy();
  });

  it('评论一句话 → 回车：sendPrompt 恰好一次，带 builder 输出且不带 localityAnchor，发送后输入行收起', async () => {
    render(<TurnDiffSummary turn={makeAuthoritativeTurn()} />);
    fireEvent.click(expandBtn());

    fireEvent.click(screen.getAllByTestId('hunk-comment-btn')[0]);
    const input = screen.getByTestId('hunk-feedback-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '把这个函数改回原来的样子' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(1));
    // 消息 = builder 对第一个块（新文件第 2 行，b→B）的真实输出：路径与行号必须真的进消息
    expect(mocks.sendPrompt.mock.calls[0][0]).toBe(
      buildDiffHunkFeedbackMessage(
        {
          filePath: '/tmp/example.ts',
          startLine: 2,
          endLine: 2,
          excerpt: '-b\n+B',
          deletionAnchor: null,
        },
        '把这个函数改回原来的样子',
      ),
    );
    // 只带一个参数：不送 localityAnchor（代码行没有产物坐标，host guard 不该收到锚点）
    expect(mocks.sendPrompt.mock.calls[0]).toHaveLength(1);
    // 一次性消息：发出即清空收起
    await waitFor(() => expect(screen.queryByTestId('hunk-feedback-input')).toBeNull());
  });

  it('换块清草稿：块 1 写半句再点块 2，草稿不跟过去（不会按块 2 的行号发出去）', async () => {
    render(<TurnDiffSummary turn={makeAuthoritativeTurn()} />);
    fireEvent.click(expandBtn());

    fireEvent.click(screen.getAllByTestId('hunk-comment-btn')[0]);
    let input = screen.getByTestId('hunk-feedback-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '这个函数' } }); // 半句话

    fireEvent.click(screen.getAllByTestId('hunk-comment-btn')[1]);
    input = screen.getByTestId('hunk-feedback-input') as HTMLInputElement;
    expect(input.value).toBe(''); // 草稿清零：半句不按块 2 的行号发出去
    expect(screen.getAllByTestId('hunk-comment-btn')[0]).toBeTruthy();
  });

  it('文件尾纯删除块：标「文件末尾」而非行号，发送走 after 语义（末尾之后补回，不夹到存活行）', async () => {
    // a/b/c 删掉 c：块锚 = 新文件长度+1，deletionAnchor='after'——消息不能把第 2 行 b 说成要改的行
    const turn = makeAuthoritativeTurn();
    turn.turnDiff!.files[0] = {
      ...turn.turnDiff!.files[0],
      oldText: 'a\nb\nc\n',
      newText: 'a\nb\n',
      added: 0,
      removed: 1,
    };
    render(<TurnDiffSummary turn={turn} />);
    fireEvent.click(expandBtn());

    expect(screen.getByText('文件末尾')).toBeTruthy();
    expect(screen.queryByText(/第 \d+ 行/)).toBeNull();

    fireEvent.click(screen.getAllByTestId('hunk-comment-btn')[0]);
    const input = screen.getByTestId('hunk-feedback-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '把删掉的加回去' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(1));
    expect(mocks.sendPrompt.mock.calls[0][0]).toBe(
      buildDiffHunkFeedbackMessage(
        { filePath: '/tmp/example.ts', startLine: 3, endLine: 3, excerpt: '-c', deletionAnchor: 'after' },
        '把删掉的加回去',
      ),
    );
    const sent = mocks.sendPrompt.mock.calls[0][0] as string;
    expect(sent).toContain('删除位置：文件末尾（第 2 行之后）');
    expect(sent).not.toContain('行号：3');
  });

  it('非权威 diff（工具 args 片段回退）不渲染块级反馈入口', () => {
    render(<TurnDiffSummary turn={makeNonAuthoritativeTurn()} />);
    fireEvent.click(expandBtn());

    expect(screen.getByTestId('diff-view-stub')).toBeTruthy();
    expect(screen.queryByTestId('turn-diff-hunk-list')).toBeNull();
    expect(screen.queryByTestId('hunk-comment-btn')).toBeNull();
  });
});
