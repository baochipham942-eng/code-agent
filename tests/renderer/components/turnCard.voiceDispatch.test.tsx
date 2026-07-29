// @vitest-environment jsdom
// ============================================================================
// W6-5 语音派活任务卡门：一通电话里派出去的活折叠成一张任务卡——
// 卡头「这件活是什么 + 谁做的 + 什么结果」，过程默认折叠，结论留在卡外。
//
// 承重条：无 speaker 时卡头一个人名都不出现（冒充人格是本批一直在治的病）；
// 失败的轮如实显示失败，绝不谎报「已完成」。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn, TraceNode } from '../../../src/shared/contract/trace';
import type { Message } from '../../../src/shared/contract/message';

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'session-1', sessions: [], messages: [], runningSessionIds: new Set<string>() };
  const useSessionStore = (selector?: (value: typeof state) => unknown) => (
    selector ? selector(state) : state
  );
  useSessionStore.getState = () => state;
  return { useSessionStore };
});

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createForkFromReply: vi.fn(),
    sendPrompt: vi.fn(),
  }),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

function dispatchNode(title: string, speaker?: { agentId: string; displayName: string }): TraceNode {
  return {
    id: 'voice-dispatch-1',
    messageId: 'voice-dispatch-1',
    type: 'assistant_text',
    content: '改写后的派活指令全文',
    timestamp: 1_000,
    metadata: { voiceDispatch: { title, ...(speaker ? { speaker } : {}) } },
  };
}

function voiceTaskTurn(overrides: Partial<TraceTurn> = {}, speaker?: { agentId: string; displayName: string }): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-voice-1',
    status: 'completed',
    startTime: 1_000,
    endTime: 9_000,
    nodes: [
      dispatchNode('建 test3.txt', speaker),
      {
        id: 'a1-text',
        messageId: 'a1',
        type: 'assistant_text',
        content: '我先看一下目录',
        timestamp: 2_000,
      },
      {
        id: 'a1-tc-1',
        messageId: 'a1',
        type: 'tool_call',
        content: '',
        timestamp: 3_000,
        toolCall: {
          id: 'tc-1',
          name: 'Grep',
          args: { pattern: 'test3' },
          success: true,
          result: 'Found 1 match',
          shortDescription: '搜索 test3 引用',
        },
      },
      {
        id: 'a2-text',
        messageId: 'a2',
        type: 'assistant_text',
        content: '已创建 test3.txt。',
        timestamp: 9_000,
      },
    ],
    ...overrides,
  } as TraceTurn;
}

afterEach(cleanup);

describe('语音派活任务卡（W6-5）', () => {
  it('折成一张卡：卡头有标题和结果状态，过程默认不在文档里，点卡头展开后出现；结论始终留在卡外', () => {
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);

    // 卡头：标题 + 已完成徽章
    const header = screen.getByTestId('voice-task-card-header');
    expect(header.textContent).toContain('建 test3.txt');
    expect(screen.getByTestId('voice-task-status').textContent).toContain('已完成');

    // 过程（改写指令全文 / 中间文本 / 工具调用）默认不在文档里
    expect(screen.queryByText('改写后的派活指令全文')).toBeNull();
    expect(screen.queryByText('我先看一下目录')).toBeNull();
    expect(screen.queryByText((_, el) => el?.textContent === '搜索 test3 引用')).toBeNull();

    // 结论不折叠：用户回头看最想看的就是「结果是什么」
    expect(screen.getByText('已创建 test3.txt。')).toBeTruthy();

    // 点卡头展开 → 过程出现；结论仍在（不是挪进卡身）。
    // 工具组头文本是按 DOM 片段拼的（图标+路径子节点），用 textContent 整串匹配。
    fireEvent.click(header);
    expect(screen.getByText('改写后的派活指令全文')).toBeTruthy();
    expect(screen.getByText('我先看一下目录')).toBeTruthy();
    expect(screen.getAllByText((_, el) => el?.textContent === '搜索 test3 引用').length).toBeGreaterThan(0);
    expect(screen.getByText('已创建 test3.txt。')).toBeTruthy();

    // 再点收起 → 过程再次离开文档
    fireEvent.click(screen.getByTestId('voice-task-card-header'));
    expect(screen.queryByText('我先看一下目录')).toBeNull();
  });

  it('speaker 存在 → 卡头显示该专家显示名', () => {
    render(<TurnCard turn={voiceTaskTurn({}, { agentId: 'muzhi', displayName: '牧之' })} sessionId="session-1" />);
    expect(screen.getByTestId('voice-task-speaker').textContent).toBe('牧之');
  });

  it('speaker 不存在 → 卡头一个人名都不出现（不编默认署名）', () => {
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);
    expect(screen.queryByTestId('voice-task-speaker')).toBeNull();
    const header = screen.getByTestId('voice-task-card-header');
    expect(header.textContent).not.toContain('Neo');
    expect(header.textContent).not.toContain('助手');
  });

  it('失败的轮（真实 projectTurns：失败留痕按 workItemId 对回任务卡）→ 卡头显示失败，不显示「已完成」', () => {
    // 与 host 落库形状逐字段对齐：voiceSessionService.reportWorkFailure。
    // 对回的键是 workItemId 而不是正文里的标题——正文是给人看的话，不是协议。
    const messages: Message[] = [
      {
        id: 'voice-dispatch-1',
        role: 'user',
        content: '改写后的派活指令全文',
        timestamp: 1_000,
        metadata: { voiceDispatch: { title: '建 test3.txt', workItemId: 'voice-work-1' } },
      },
      {
        id: 'voice-work-failed-1',
        role: 'system',
        // 正文刻意不写成 host 现在那句中文模板：对回任务卡的键必须是 workItemId。
        // 谁要是改回「按正文反解标题」，这一条当场转红——而那种实现会在文案一改、
        // 或这句话进一次 i18n 时静默失效，失败从此不再显示。
        content: 'Voice-dispatched task failed: quota exceeded',
        timestamp: 5_000,
        metadata: { source: 'voice', voiceWorkFailure: { workItemId: 'voice-work-1', title: '建 test3.txt' } },
      },
    ];

    const projection = projectTurns(messages, 'session-1', false);
    const voiceTurn = projection.turns.find((turn) => (
      turn.nodes.some((node) => node.metadata?.voiceDispatch)
    ));
    expect(voiceTurn).toBeTruthy();
    // 失败留痕进了任务卡所在轮，没有被当普通 system 消息吞掉
    expect(voiceTurn!.nodes.some((node) => node.subtype === 'error' && node.metadata?.source === 'voice')).toBe(true);

    render(<TurnCard turn={voiceTurn!} sessionId="session-1" />);
    const status = screen.getByTestId('voice-task-status');
    expect(status.textContent).toContain('失败');
    expect(status.textContent).not.toContain('已完成');
    expect(screen.getByTestId('voice-task-card-header').textContent).not.toContain('已完成');
  });

  it('拿不准就不报状态：正常完成但没有任何结论正文时，卡头不出现状态徽章', () => {
    const turn = voiceTaskTurn({
      nodes: [dispatchNode('建 test3.txt')],
    });
    render(<TurnCard turn={turn} sessionId="session-1" />);
    expect(screen.queryByTestId('voice-task-status')).toBeNull();
    // 卡头仍在，标题在——只是不猜一个结果
    expect(screen.getByTestId('voice-task-card-header').textContent).toContain('建 test3.txt');
  });

  it('普通（非语音）turn 完全不受影响：无任务卡卡头，节点照常铺开', () => {
    const plainTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-plain',
      status: 'completed',
      startTime: 1_000,
      endTime: 2_000,
      nodes: [
        { id: 'u1', type: 'user', content: '手打的问题', timestamp: 1_000 },
        { id: 'a1-text', messageId: 'a1', type: 'assistant_text', content: '手打的回答', timestamp: 2_000 },
      ],
    } as TraceTurn;

    render(<TurnCard turn={plainTurn} sessionId="session-1" />);
    expect(screen.queryByTestId('voice-task-card-header')).toBeNull();
    expect(screen.getByText('手打的问题')).toBeTruthy();
    expect(screen.getByText('手打的回答')).toBeTruthy();
  });
});
