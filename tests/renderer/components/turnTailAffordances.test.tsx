// @vitest-environment jsdom
// ============================================================================
// 一轮的尾部：时间只说一次，评价挂在整轮末尾
// ============================================================================
// 第 17 条：一屏里原来有轮级「用时 30s」和分隔线上同一个数字的裸重复，
//           外加每个工具的裸「2.6s」——三处时间没有一处说明彼此关系。
// 第 20 条：点赞点踩挂在最后一个正文节点内部渲染，于是插在「已创建 x.txt。」
//           和它产出的文件卡之间，看起来像在给上面那一句话打分。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'session-1', sessions: [], messages: [] };
  const useSessionStore = (selector?: (value: typeof state) => unknown) => (
    selector ? selector(state) : state
  );
  useSessionStore.getState = () => state;
  return { useSessionStore };
});
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

// FOLD_THRESHOLD=5：给足节点数才会出现「用时」折叠按钮
function longTurn(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 1_000,
    endTime: 31_000,
    nodes: [
      { id: 'user-1', type: 'user', content: '建个文件', timestamp: 1_000 },
      {
        id: 'tool-1',
        type: 'tool_call',
        timestamp: 2_000,
        toolCall: {
          id: 'tc-1',
          name: 'Grep',
          args: { pattern: 'TODO' },
          success: true,
          result: 'Found 3 matches',
          duration: 2_600,
        },
      },
      {
        id: 'tool-2',
        type: 'tool_call',
        timestamp: 2_500,
        toolCall: {
          id: 'tc-2',
          name: 'Read',
          args: { file_path: '/work/notes.md' },
          success: true,
          result: '12 lines',
          duration: 1_400,
        },
      },
      {
        id: 'tool-3',
        type: 'tool_call',
        timestamp: 3_000,
        toolCall: {
          id: 'tc-3',
          name: 'Write',
          args: { file_path: '/work/gear.txt', content: '齿轮\n' },
          success: true,
          result: 'Created file: /work/gear.txt',
          duration: 900,
        },
      },
      { id: 'noise-1', type: 'assistant_text', content: '先看看现状。', timestamp: 4_000 },
      {
        id: 'assistant-1',
        type: 'assistant_text',
        content: '已创建 gear.txt。',
        timestamp: 30_000,
        messageId: 'msg-final',
        feedbackEligible: true,
      },
    ],
  } as unknown as TraceTurn;
}

function visibleText(): string {
  return document.body.textContent ?? '';
}

describe('轮尾：时间与评价', () => {
  it('轮时长只说一次，而且带「用时」标签', () => {
    render(React.createElement(TurnCard, { turn: longTurn(), forceExpanded: true }));

    const text = visibleText();
    expect(text).toContain('用时 30s');
    // 分隔线上原来还有一个同样的裸数字
    expect(text.split('30s').length - 1).toBe(1);
  });

  it('单个工具的裸秒数不再上屏——「这段花了多久」由组头一处回答', () => {
    render(React.createElement(TurnCard, { turn: longTurn(), forceExpanded: true }));

    const text = visibleText();
    // 组头给合计 4.0s；Grep 的 2.6s 与 Read 的 1.4s 都不该各挂一个
    expect(text).toContain('4.0s');
    expect(text).not.toContain('2.6s');
    expect(text).not.toContain('1.4s');
  });

  it('点赞点踩在整轮最后，排在文件变更卡之后', () => {
    render(React.createElement(TurnCard, { turn: longTurn(), forceExpanded: true }));

    const feedback = screen.getByTestId('turn-feedback');
    const answer = screen.getByText('已创建 gear.txt。');
    const diffCard = screen.getByText('已编辑 1 个文件');

    // DOM 顺序：答案 → 文件卡 → 评价。用 compareDocumentPosition 而不是看类名，
    // 换版式也照样成立。
    const answerBeforeCard = answer.compareDocumentPosition(diffCard)
      & Node.DOCUMENT_POSITION_FOLLOWING;
    const cardBeforeFeedback = diffCard.compareDocumentPosition(feedback)
      & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(answerBeforeCard).toBeTruthy();
    expect(cardBeforeFeedback).toBeTruthy();
  });

  it('这一轮没有可评价的最终答案时不出现评价按钮', () => {
    const turn = longTurn();
    turn.nodes = turn.nodes.map((node) => (
      node.id === 'assistant-1' ? { ...node, feedbackEligible: false } : node
    ));
    render(React.createElement(TurnCard, { turn, forceExpanded: true }));

    expect(screen.queryByTestId('turn-feedback')).toBeNull();
  });
});

afterEach(cleanup);
