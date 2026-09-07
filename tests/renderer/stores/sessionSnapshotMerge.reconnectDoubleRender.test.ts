import { describe, expect, it } from 'vitest';
import type { Message, StreamRecoverySnapshot } from '../../../src/shared/contract';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { applyToolExecutionEvent } from '../../../src/renderer/hooks/agent/effects/useToolExecutionEffects';
import type { ConversationStreamEventActions } from '../../../src/renderer/hooks/agent/effects/streamEventTypes';
import type { ToolExecutionEventDeps } from '../../../src/renderer/hooks/agent/effects/useToolExecutionEffects';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { mergeSnapshotWithLiveTail } from '../../../src/renderer/stores/sessionSnapshotMerge';
import { mergeStreamSnapshotIntoMessages } from '../../../src/renderer/utils/streamRecoveryMessage';
import { applyStreamingMessageDeltasToProjection } from '../../../src/renderer/utils/streamingProjectionOverlay';

const SESSION_ID = 'session-meeting-dir';
const LIVE_TURN_ID = 'turn-live-1';
const NEXT_TURN_ID = 'turn-live-2';
const HOST_MESSAGE_ID = 'host-msg-1';
const USER_ID = 'user-1';
const ANSWER = '腾讯会议的目录在用户数据文件夹下，常见路径包括 Documents 与 Application Support。清理缓存前先退出客户端。';

function streamState() {
  return {
    currentTurnMessageId: null as string | null,
    committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
  };
}

function streamActions(getMessages: () => Message[], setMessages: (next: Message[]) => void): ConversationStreamEventActions {
  return {
    addMessage: (message) => setMessages([...getMessages(), message]),
    updateMessage: (id, updates) => {
      setMessages(getMessages().map((message) => (
        message.id === id ? { ...message, ...updates } : message
      )));
    },
    appendStreamingMessageDelta: (messageId, delta) => {
      setMessages(getMessages().map((message) => {
        if (message.id !== messageId || message.role !== 'assistant') return message;
        return {
          ...message,
          content: `${message.content ?? ''}${delta.content ?? ''}`,
          reasoning: `${message.reasoning ?? ''}${delta.reasoning ?? ''}` || undefined,
        };
      }));
    },
    setMessages,
    getMessages,
    queueUpdate: () => {},
    now: () => 1_700,
  };
}

function toolDeps(getMessages: () => Message[], setMessages: (next: Message[]) => void): ToolExecutionEventDeps {
  return {
    clearAgentPointers: () => {},
    debug: () => {},
    dispatchBridgeToolCall: () => {},
    getCurrentSessionId: () => SESSION_ID,
    getCurrentTurnMessageId: () => NEXT_TURN_ID,
    getMessages,
    isDev: false,
    now: () => 1_800,
    queueUpdate: () => {},
    recordAgentPointer: () => {},
    setActiveToolProgress: () => {},
    setCapabilityGapNotice: () => {},
    setLastEventAt: () => {},
    setToolTimeoutWarning: () => {},
    updateMessage: (id, updates) => {
      setMessages(getMessages().map((message) => (
        message.id === id ? { ...message, ...updates } : message
      )));
    },
    warn: () => {},
  };
}

function replayLiveTurn(messages: Message[]): { messages: Message[]; state: ReturnType<typeof streamState> } {
  let current = messages;
  const state = streamState();
  const getMessages = () => current;
  const setMessages = (next: Message[]) => {
    current = next;
  };
  const actions = streamActions(getMessages, setMessages);

  applyConversationStreamEvent(
    { type: 'turn_start', sessionId: SESSION_ID, data: { turnId: LIVE_TURN_ID } },
    state,
    actions,
  );
  applyConversationStreamEvent(
    { type: 'stream_chunk', sessionId: SESSION_ID, data: { turnId: LIVE_TURN_ID, content: ANSWER, deltaSeq: 1 } },
    state,
    actions,
  );
  applyConversationStreamEvent(
    {
      type: 'message',
      sessionId: SESSION_ID,
      data: {
        id: HOST_MESSAGE_ID,
        turnId: LIVE_TURN_ID,
        content: ANSWER,
      },
    },
    state,
    actions,
  );
  applyConversationStreamEvent(
    { type: 'turn_start', sessionId: SESSION_ID, data: { turnId: NEXT_TURN_ID } },
    state,
    actions,
  );
  applyToolExecutionEvent(
    {
      type: 'stream_tool_call_start',
      sessionId: SESSION_ID,
      data: {
        id: 'call-websearch-1',
        name: 'WebSearch',
        turnId: NEXT_TURN_ID,
        index: 0,
      },
    },
    toolDeps(getMessages, setMessages),
  );

  return { messages: current, state };
}

function hostPersistedSnapshot(live: Message[]): Message[] {
  const user = live.find((message) => message.id === USER_ID);
  if (!user) throw new Error('missing user message');
  return [
    user,
    {
      id: HOST_MESSAGE_ID,
      role: 'assistant',
      content: ANSWER,
      timestamp: 1_700,
    },
  ];
}

function inFlightSnapshot(): StreamRecoverySnapshot {
  return {
    sessionId: SESSION_ID,
    turnId: NEXT_TURN_ID,
    content: '',
    reasoning: '',
    toolCalls: [{ id: 'call-websearch-1', name: 'WebSearch', arguments: '{"query":"tencent meeting directory"}' }],
    estimatedTokens: 8,
    timestamp: 1_800,
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: ['call-websearch-1'],
  };
}

function visibleSequence(turn: TraceTurn): string[] {
  return turn.nodes.flatMap((node) => {
    if (node.type === 'assistant_text' && node.content.trim()) return [node.content];
    if (node.type === 'tool_call' && node.toolCall?.name) return [`tool:${node.toolCall.name}`];
    return [];
  });
}

describe('reconnect/replay: assistant body renders once', () => {
  it('force snapshot + live tail + replayed chunks keep one body and do not sandwich the tool', () => {
    const seeded: Message[] = [
      { id: USER_ID, role: 'user', content: '腾讯会议目录在哪', timestamp: 1_000 },
    ];
    const { messages: live, state } = replayLiveTurn(seeded);

    const snapshotMessages = mergeStreamSnapshotIntoMessages(
      hostPersistedSnapshot(live),
      inFlightSnapshot(),
      true,
    );
    const merged = mergeSnapshotWithLiveTail(snapshotMessages, live).messages;

    const replayState = {
      currentTurnMessageId: state.currentTurnMessageId,
      committedAssistantMessageIds: new Set(state.committedAssistantMessageIds),
      lastDeltaSeqByTurn: new Map(state.lastDeltaSeqByTurn),
    };
    let afterReplay = merged;
    applyConversationStreamEvent(
      { type: 'stream_chunk', sessionId: SESSION_ID, data: { turnId: LIVE_TURN_ID, content: ANSWER, deltaSeq: 1 } },
      replayState,
      streamActions(() => afterReplay, (next) => {
        afterReplay = next;
      }),
    );
    applyConversationStreamEvent(
      {
        type: 'message',
        sessionId: SESSION_ID,
        data: { id: HOST_MESSAGE_ID, turnId: LIVE_TURN_ID, content: ANSWER },
      },
      replayState,
      streamActions(() => afterReplay, (next) => {
        afterReplay = next;
      }),
    );

    const projection = applyStreamingMessageDeltasToProjection(
      projectTurns(afterReplay, SESSION_ID, true),
      afterReplay,
      { [LIVE_TURN_ID]: { contentDelta: ANSWER, reasoningDelta: '', updatedAt: 1_900 } },
    );
    const turn = projection.turns[projection.turns.length - 1];
    const sequence = visibleSequence(turn);
    const answerCopies = sequence.filter((item) => item === ANSWER);

    expect(afterReplay.filter((message) => message.role === 'assistant' && message.content === ANSWER)).toHaveLength(1);
    expect(answerCopies).toHaveLength(1);
    expect(sequence).toEqual([ANSWER, 'tool:WebSearch']);
  });

  it('does not merge a short preamble with a later long answer in the same user turn', () => {
    const snapshot: Message[] = [
      { id: USER_ID, role: 'user', content: '查一下', timestamp: 1 },
      { id: 'host-preamble', role: 'assistant', content: '好的。', timestamp: 2 },
      { id: 'host-answer', role: 'assistant', content: ANSWER, timestamp: 3 },
    ];
    const live: Message[] = [
      { id: USER_ID, role: 'user', content: '查一下', timestamp: 1 },
      { id: 'turn-preamble', role: 'assistant', content: '好的。', timestamp: 2 },
      { id: 'turn-answer', role: 'assistant', content: ANSWER, timestamp: 3 },
    ];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;
    const assistant = merged.filter((message) => message.role === 'assistant');
    expect(assistant.map((message) => message.content)).toEqual(['好的。', ANSWER]);
  });
});

// ai-review #1696 第三轮③：正文相似只是弱证据，两轮回答碰巧一样就会被并掉，
// 而合并只保留工具调用多的那一边 ⇒ 另一边整组工具调用消失。
describe('相似度合并的护栏：工具调用冲突时不合', () => {
  const user = (id: string): Message => ({ id, role: 'user', content: '同一个问题', timestamp: 1 });
  const assistant = (id: string, toolCallIds: string[]): Message => ({
    id,
    role: 'assistant',
    content: '一模一样的回答正文，长度足够触发相似度判定的门槛',
    timestamp: 2,
    toolCalls: toolCallIds.map((tid) => ({ id: tid, name: 'Bash', arguments: {} })) as never,
  });

  it('两边工具调用互不为子集时拒绝合并（各自的工具调用都不许消失）', () => {
    const snapshot = [user('u-1'), assistant('a-old', ['call-old'])];
    const live = [user('u-1'), assistant('a-new', ['call-new'])];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;

    const toolIds = merged.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id));
    expect(toolIds).toContain('call-old');
  });

  it('一边没有工具调用时照常合并（本单要治的重复渲染不受影响）', () => {
    const snapshot = [user('u-2'), assistant('a-old2', [])];
    const live = [user('u-2'), assistant('a-new2', ['call-x'])];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;

    expect(merged.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});
