import { describe, expect, it } from 'vitest';
import type { ContentPart, Message, StreamRecoverySnapshot } from '../../../src/shared/contract';
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

  // ai-review #1696 第四轮②：一边没有工具调用时护栏放行，但两边各带不同 artifacts/
  // 附件时，「哪边多留哪边」会让较早那条的产物入口整组消失。合并必须无损。
  it('合并是无损的：两边各自的附件与工具调用都留在结果里', () => {
    const withPayload = (id: string, toolId: string, attId: string): Message => ({
      id,
      role: 'assistant',
      content: '一模一样的回答正文，长度足够触发相似度判定的门槛',
      timestamp: 2,
      toolCalls: [{ id: toolId, name: 'Bash', arguments: {} }] as never,
      attachments: [{ id: attId, name: `${attId}.png`, type: 'image', size: 1, data: 'x' }] as never,
    });
    const snapshot = [user('u-3'), withPayload('a-old3', 'call-old', 'att-old')];
    const live = [user('u-3'), withPayload('a-new3', 'call-old', 'att-new')];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;

    const assistants = merged.filter((m) => m.role === 'assistant');
    const attIds = assistants.flatMap((m) => (m.attachments ?? []).map((a) => a.id));
    expect(attIds).toContain('att-old');
    expect(attIds).toContain('att-new');
  });

  // ai-review #1696 第五轮①：同 id 先到先得会把 live 那份刚到的执行结果清掉。
  it('同 id 工具调用以 live 那份为准（旧快照不许清掉刚到的结果）', () => {
    const call = (status: string, output?: string) => ([{
      id: 'call-same', name: 'Bash', arguments: {},
      ...(output ? { result: { toolCallId: 'call-same', success: true, output } } : {}),
      status,
    }] as never);
    const snapshot = [user('u-4'), { ...assistant('a-old4', []), toolCalls: call('running') }];
    const live = [user('u-4'), { ...assistant('a-new4', []), toolCalls: call('done', '产物路径 /tmp/out.md') }];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;
    const calls = merged.flatMap((m) => m.toolCalls ?? []);

    expect(calls).toHaveLength(1);
    expect((calls[0] as never as { result?: { output?: string } }).result?.output)
      .toContain('/tmp/out.md');
  });

  // ai-review #1696 第五轮②：artifacts 不在点名清单里就被 live 直接覆盖。
  // 现在改成「所有数组载荷默认取并集」，新增载荷种类不用再补规则。
  it('未点名的数组载荷（artifacts）同样取并集', () => {
    const withArtifacts = (id: string, artId: string): Message => ({
      ...assistant(id, []),
      artifacts: [{ id: artId, name: `${artId}.md` }],
    } as never);
    const snapshot = [user('u-5'), withArtifacts('a-old5', 'art-old')];
    const live = [user('u-5'), withArtifacts('a-new5', 'art-new')];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;
    const artIds = merged.flatMap((m) => ((m as never as { artifacts?: { id: string }[] }).artifacts ?? []).map((a) => a.id));

    expect(artIds).toContain('art-old');
    expect(artIds).toContain('art-new');
  });

  it('一边没有工具调用时照常合并（本单要治的重复渲染不受影响）', () => {
    const snapshot = [user('u-2'), assistant('a-old2', [])];
    const live = [user('u-2'), assistant('a-new2', ['call-x'])];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;

    expect(merged.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

// ai-review #1696 第六轮：跨 ID 合并时 contentParts 按「元素个数」选更长那份，
// 带工具分段的旧快照元素更多、承载正文却更短 ⇒ 投影只渲染旧分段，live 已显示的
// 新正文整个消失。取舍判据改为「承载正文必须覆盖合并后的 content」，覆盖不了
// 就整份弃用，回落 content 直渲。
describe('contentParts 取舍：承载正文覆盖不了合并后 content 就整份弃用', () => {
  const P = '前半段正文，长度必须超过三十二个字符才能通过流式草稿配对的前缀门槛。';
  const Q = '后半段新增正文：用户已经在 live 里看到这一段，合并后它不许消失。';
  const user = (): Message => ({ id: 'u-cp', role: 'user', content: '同一个问题', timestamp: 1 });
  const toolCall = (id: string, name: string) => ({ id, name, arguments: {} }) as never;
  const mergedAssistant = (snapshot: Message[], live: Message[]) => (
    mergeSnapshotWithLiveTail(snapshot, live).messages.find((m) => m.role === 'assistant')
  );
  const visibleText = (merged: Message[]): string[] => (
    projectTurns(merged, SESSION_ID, true).turns.flatMap((turn) => visibleSequence(turn))
  );

  it('快照分段承载不下 live 正文时弃用 contentParts，合并后正文完整直渲', () => {
    const snapshot: Message[] = [
      user(),
      {
        id: 'a-snap', role: 'assistant', content: P, timestamp: 2,
        contentParts: [{ type: 'text', text: P }, { type: 'tool_call', toolCallId: 'call-cp-1' }],
        toolCalls: [toolCall('call-cp-1', 'WebSearch')],
      },
    ];
    const live: Message[] = [
      user(),
      { id: 'a-live', role: 'assistant', content: P + Q, timestamp: 3, toolCalls: [toolCall('call-cp-1', 'WebSearch')] },
    ];

    const merged = mergeSnapshotWithLiveTail(snapshot, live).messages;
    const assistant = merged.find((m) => m.role === 'assistant');

    expect(assistant?.content).toBe(P + Q);
    expect(assistant?.contentParts).toBeUndefined();
    expect(visibleText(merged)).toEqual([P + Q, 'tool:WebSearch']);
  });

  it('live 分段能覆盖合并后正文时保留交错顺序（正文—工具—正文）', () => {
    const liveParts: ContentPart[] = [
      { type: 'text', text: P },
      { type: 'tool_call', toolCallId: 'call-cp-1' },
      { type: 'text', text: Q },
    ];
    const snapshot: Message[] = [
      user(),
      { id: 'a-snap', role: 'assistant', content: P, timestamp: 2, toolCalls: [toolCall('call-cp-1', 'WebSearch')] },
    ];
    const live: Message[] = [
      user(),
      {
        id: 'a-live', role: 'assistant', content: P + Q, timestamp: 3,
        contentParts: liveParts, toolCalls: [toolCall('call-cp-1', 'WebSearch')],
      },
    ];

    const assistant = mergedAssistant(snapshot, live);

    expect(assistant?.contentParts).toBe(liveParts);
    expect(visibleText(mergeSnapshotWithLiveTail(snapshot, live).messages)).toEqual([P, 'tool:WebSearch', Q]);
  });

  it('元素更多但承载正文更短的旧分段，输给元素更少但覆盖全的新分段', () => {
    const liveParts: ContentPart[] = [{ type: 'text', text: P + Q }];
    const snapshot: Message[] = [
      user(),
      {
        id: 'a-snap', role: 'assistant', content: P, timestamp: 2,
        contentParts: [
          { type: 'text', text: P },
          { type: 'tool_call', toolCallId: 'call-cp-1' },
          { type: 'tool_call', toolCallId: 'call-cp-2' },
        ],
        toolCalls: [toolCall('call-cp-1', 'WebSearch'), toolCall('call-cp-2', 'Bash')],
      },
    ];
    const live: Message[] = [
      user(),
      {
        id: 'a-live', role: 'assistant', content: P + Q, timestamp: 3,
        contentParts: liveParts,
        toolCalls: [toolCall('call-cp-1', 'WebSearch'), toolCall('call-cp-2', 'Bash')],
      },
    ];

    const assistant = mergedAssistant(snapshot, live);

    expect(assistant?.contentParts).toBe(liveParts);
    expect(visibleText(mergeSnapshotWithLiveTail(snapshot, live).messages)).toContain(P + Q);
  });
});
