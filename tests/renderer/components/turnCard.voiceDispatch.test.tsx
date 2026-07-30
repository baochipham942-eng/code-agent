// @vitest-environment jsdom
// ============================================================================
// W6-5 语音派活任务卡门：一通电话里派出去的活折叠成一张任务卡——
// 卡头「这件活是什么 + 谁做的」，过程默认折叠，结论留在卡外。
//
// 承重条：无 speaker 时卡头一个人名都不出现（冒充人格是本批一直在治的病）；
// 卡头不显示任何状态徽章（X5.5 返工批 R4a 产品拍板）——结局判定是 host 证据门
// 的事（voiceWorkOutcome 照常落库、照常对回卡片轮），卡片一律不转述。
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
    // host 结局印章（X5.5-A2-a）照常落在轮上：R4a 之后卡片不再转述它，
    // 但投影层对回机制不动，下面投影用例继续钉。夹具默认带 done 章，
    // 是为了证明「有章也不显示徽章」。
    voiceWorkOutcome: 'done',
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
  it('折成一张卡：卡头有标题、无任何状态徽章，过程默认不在文档里，点卡头展开后出现；结论始终留在卡外', () => {
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);

    // 卡头：标题在；带 done 章也不显示任何状态徽章（R4a）
    const header = screen.getByTestId('voice-task-card-header');
    expect(header.textContent).toContain('建 test3.txt');
    expect(screen.queryByTestId('voice-task-status')).toBeNull();
    expect(header.textContent).not.toContain('已完成');

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

  it('卡头与正文同一左缘基线（R4b）：负 margin 抵消 Button 内边距，且不许再有 px-* 覆盖类', () => {
    // 真机截图实锤：卡头（波形图标+标题）比正文气泡右移一截。根因：Button size=sm
    // 自带 px-3，旧 className 的 px-2 在 TW4 层叠里被 px-3 盖住（同族间距大值赢，
    // 与书写顺序无关）——图标被顶到内容边右 12px。钉死两件事：
    //   ① -mx-3 负 margin 把整行拉回容器内容边（正文左缘所在）；
    //   ② 不许再出现 px-* 覆盖类——那是同一条死路，再写一次还是死类。
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);
    const header = screen.getByTestId('voice-task-card-header');
    expect(header.className).toContain('-mx-3');
    // 唯一的水平 padding 必须是 Button sm 自带的 px-3（由 -mx-3 抵消）；
    // 除此之外的任何 px-* 覆盖类都是「再写一次还是死类」的同一条死路。
    expect(header.className).not.toMatch(/(?:^|\s)px-(?!3(?:\s|$))/);
  });

  it('speaker 不存在 → 卡头一个人名都不出现（不编默认署名）', () => {
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);
    expect(screen.queryByTestId('voice-task-speaker')).toBeNull();
    const header = screen.getByTestId('voice-task-card-header');
    expect(header.textContent).not.toContain('Neo');
    expect(header.textContent).not.toContain('助手');
  });

  it('失败的轮（真实 projectTurns：失败留痕按 workItemId 对回任务卡）→ 留痕进轮，但卡头照样不显示任何状态徽章（R4a）', () => {
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
        // 或这句话进一次 i18n 时静默失效，失败留痕从此对不回任务卡。
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
    // 失败也不显示徽章——卡头一律没有状态徽章，不是只报喜不报忧
    expect(screen.queryByTestId('voice-task-status')).toBeNull();
    expect(screen.getByTestId('voice-task-card-header').textContent).not.toContain('已完成');
  });

  it('没有 host 结局印章的轮：卡头同样没有状态徽章，标题照在', () => {
    const turn = voiceTaskTurn({
      nodes: [dispatchNode('建 test3.txt')],
      voiceWorkOutcome: undefined,
    });
    render(<TurnCard turn={turn} sessionId="session-1" />);
    expect(screen.queryByTestId('voice-task-status')).toBeNull();
    // 卡头仍在，标题在
    expect(screen.getByTestId('voice-task-card-header').textContent).toContain('建 test3.txt');
  });

  // ---- X5.5-A2-a 完成语义证据门（投影层）+ R4a（渲染层）----
  // host 的 outcome 机制不动：印章照常落库、照常对回任务卡所在轮；
  // R4a 产品拍板：卡片一律不转述结局——有章无章、done/unverified 都不显示徽章。

  it('无印章的完整一轮：不显示徽章，结论正文照旧留在卡外', () => {
    const turn = voiceTaskTurn({ voiceWorkOutcome: undefined });
    render(<TurnCard turn={turn} sessionId="session-1" />);

    expect(screen.queryByTestId('voice-task-status')).toBeNull();
    expect(screen.getByTestId('voice-task-card-header').textContent).not.toContain('已完成');
    // 结论正文照旧留在卡外
    expect(screen.getByText('已创建 test3.txt。')).toBeTruthy();
  });

  it('印章是 unverified：同样不显示徽章，一个「已结束 · 待核验」都没有', () => {
    const turn = voiceTaskTurn({ voiceWorkOutcome: 'unverified' });
    render(<TurnCard turn={turn} sessionId="session-1" />);

    expect(screen.queryByTestId('voice-task-status')).toBeNull();
    expect(screen.getByTestId('voice-task-card-header').textContent).not.toContain('待核验');
  });

  it('真实 projectTurns：结局印章按 workItemId 对回任务卡，且自己不占一条气泡', () => {
    // 与 host 落库形状逐字段对齐：voiceAgentCoordinator.persistWorkOutcome
    const messages: Message[] = [
      {
        id: 'voice-dispatch-1',
        role: 'user',
        content: '改写后的派活指令全文',
        timestamp: 1_000,
        metadata: { voiceDispatch: { title: '建 test3.txt', workItemId: 'voice-work-1' } },
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '已创建 test3.txt。',
        timestamp: 4_000,
      },
      {
        id: 'voice-work-settled-1',
        role: 'system',
        // 正文只是兜底可读性；对回任务卡的键必须是 workItemId（拿正文反解标题＝拿人话当协议）
        content: 'Voice-dispatched task finished without artifacts',
        timestamp: 5_000,
        metadata: {
          source: 'voice',
          voiceWorkSettled: { workItemId: 'voice-work-1', title: '建 test3.txt', outcome: 'unverified' },
        },
      },
    ];

    const projection = projectTurns(messages, 'session-1', false);
    const voiceTurn = projection.turns.find((turn) => (
      turn.nodes.some((node) => node.metadata?.voiceDispatch)
    ));
    expect(voiceTurn?.voiceWorkOutcome).toBe('unverified');
    // 印章是给卡片看的，不是说给用户的话：它不许变成会话里的一条节点
    expect(projection.turns.flatMap((turn) => turn.nodes)
      .some((node) => node.metadata?.voiceWorkSettled)).toBe(false);

    render(<TurnCard turn={voiceTurn!} sessionId="session-1" />);
    // 印章对回了轮，但卡片不转述（R4a）
    expect(screen.queryByTestId('voice-task-status')).toBeNull();
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
