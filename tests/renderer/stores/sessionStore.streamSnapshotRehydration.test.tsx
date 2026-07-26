// @vitest-environment jsdom
// F4：生成中切会话再回来，已渲染的流式内容消失。
// 全链路回归（真实 sessionStore + 真实 projectTurns 投影 + 真实 streaming overlay +
// 真实 applyConversationStreamEvent，不 mock 投影/model 层）：
//   重水化（DB 消息 + 非 final streamSnapshot）→ partial 上屏 → 后续流式事件按 turnId
//   寻址接上 → 'message' 提交事件落账不重复。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Session, StreamRecoverySnapshot } from '../../../src/shared/contract';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useStreamingMessageAccumulatorStore } from '../../../src/renderer/stores/streamingMessageAccumulatorStore';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { applyStreamingMessageDeltasToProjection } from '../../../src/renderer/utils/streamingProjectionOverlay';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import type { ConversationStreamEventActions } from '../../../src/renderer/hooks/agent/effects/streamEventTypes';
import { hasIncompleteStreamSnapshot } from '../../../src/renderer/utils/streamingStatePresentation';
import { deriveRetryTurnMessage } from '../../../src/renderer/components/ChatView';

const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn();

const SNAPSHOT_TURN_ID = 'host-turn-uuid-9';

function makeSnapshot(overrides: Partial<StreamRecoverySnapshot> = {}): StreamRecoverySnapshot {
  return {
    sessionId: 'session-1',
    turnId: SNAPSHOT_TURN_ID,
    content: '已经生成的部分',
    reasoning: '思考了一半',
    toolCalls: [],
    estimatedTokens: 12,
    timestamp: 3_000,
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
    ...overrides,
  };
}

function makeSession(snapshot: StreamRecoverySnapshot | null): Session & { messages: Message[] } {
  return {
    id: 'session-1',
    title: '历史会话',
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: '', maxTokens: 16384 },
    createdAt: 1,
    updatedAt: 2,
    status: 'running',
    messages: [
      { id: 'u-1', role: 'user', content: '第一个问题', timestamp: 1 },
      { id: 'a-1', role: 'assistant', content: '第一个回答', timestamp: 2 },
      { id: 'u-2', role: 'user', content: '帮我写个函数', timestamp: 2_500 },
    ],
    ...(snapshot ? { streamSnapshot: snapshot } : {}),
  };
}

/** 与 useConversationStreamEffects 生产接线一致：事件动作落到真实 store。 */
function makeRealActions(): ConversationStreamEventActions {
  return {
    addMessage: (message) => useSessionStore.getState().addMessage(message),
    updateMessage: (id, updates) => useSessionStore.getState().updateMessage(id, updates),
    appendStreamingMessageDelta: (messageId, delta) =>
      useStreamingMessageAccumulatorStore.getState().appendDelta(messageId, delta),
    setMessages: (messages) => useSessionStore.getState().setMessages(messages),
    getMessages: () => useSessionStore.getState().messages,
    queueUpdate: () => {},
    now: () => 4_000,
  };
}

/** 模拟 hook 重挂载后的最坏情况：currentTurnMessageId 已丢，只能靠事件里的 turnId 寻址。 */
function makeRemountedStreamState() {
  return {
    currentTurnMessageId: null as string | null,
    committedAssistantMessageIds: new Set<string>(),
  };
}

function turnText(turn: TraceTurn): string {
  return turn.nodes
    .filter((node) => node.type === 'assistant_text')
    .map((node) => node.content)
    .join('');
}

describe('F4 切回重水化：streamSnapshot partial 合入与流式续接', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        off: vi.fn(),
      },
    };
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      messages: [],
      todos: [],
      streamSnapshot: null,
      isLoading: false,
      error: null,
      unreadSessionIds: new Set<string>(),
      runningSessionIds: new Set<string>(),
      sessionRuntimes: new Map(),
      backgroundSessions: [],
      hasOlderMessages: false,
      isLoadingOlder: false,
    });
    useStreamingMessageAccumulatorStore.setState({ entries: {}, visibleEntries: {} });

    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') {
        return { success: true, data: makeSession(makeSnapshot()) };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks') {
        return { success: true, data: [] };
      }
      return { success: false, error: { message: `unexpected domain call: ${action}` } };
    });
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CONTEXT_HEALTH_GET) return null;
      return null;
    });
  });

  it('重水化把非 final snapshot 合入为 streaming assistant 消息，partial 经真实投影上屏，后续流式事件无缝接上', async () => {
    await useSessionStore.getState().switchSession('session-1');

    // 1) partial 合入：messages 末尾多了以 snapshot.turnId 为 id 的 assistant 消息；
    //    snapshot 本体留在 store（不走 addMessage，不被无条件清掉）。
    const { messages, streamSnapshot } = useSessionStore.getState();
    expect(streamSnapshot?.turnId).toBe(SNAPSHOT_TURN_ID);
    const recoveryMessage = messages.find((message) => message.id === SNAPSHOT_TURN_ID);
    expect(recoveryMessage?.role).toBe('assistant');
    expect(recoveryMessage?.content).toBe('已经生成的部分');
    expect(recoveryMessage?.reasoning).toBe('思考了一半');

    // 2) 真实投影：末轮是 streaming 活动轮，partial 正文可见。
    const baseProjection = projectTurns(messages, 'session-1', true);
    const activeTurn = baseProjection.turns[baseProjection.activeTurnIndex];
    expect(activeTurn.status).toBe('streaming');
    expect(turnText(activeTurn)).toContain('已经生成的部分');

    // 3) 后续流式事件到达：hook 已重挂载（currentTurnMessageId 丢失），
    //    只能按事件里的 turnId 寻址——合入的消息 id 就是 snapshot.turnId，自然命中。
    applyConversationStreamEvent(
      { type: 'stream_chunk', sessionId: 'session-1', data: { turnId: SNAPSHOT_TURN_ID, content: '，切走期间的后续' } },
      makeRemountedStreamState(),
      makeRealActions(),
    );
    const entries = useStreamingMessageAccumulatorStore.getState().entries;
    expect(entries[SNAPSHOT_TURN_ID]?.contentDelta).toBe('，切走期间的后续');

    // 4) overlay 叠加后：用户看到 partial + 新增量连成一段。
    const overlaid = applyStreamingMessageDeltasToProjection(
      projectTurns(useSessionStore.getState().messages, 'session-1', true),
      useSessionStore.getState().messages,
      entries,
    );
    const overlaidTurn = overlaid.turns[overlaid.turns.length - 1];
    expect(turnText(overlaidTurn)).toBe('已经生成的部分，切走期间的后续');

    // 5) 模型 iteration 提交（'message' 事件，host 落库同款内容）：按 turnId 找到同一条
    //    消息落账，不新增重复消息；accumulator 被消费后投影内容不翻倍。
    useStreamingMessageAccumulatorStore.getState().consumeDelta(SNAPSHOT_TURN_ID);
    applyConversationStreamEvent(
      {
        type: 'message',
        sessionId: 'session-1',
        data: {
          turnId: SNAPSHOT_TURN_ID,
          id: 'host-msg-1',
          content: '已经生成的部分，切走期间的后续',
          reasoning: '思考了一半',
        },
      },
      makeRemountedStreamState(),
      makeRealActions(),
    );
    const committed = useSessionStore.getState().messages;
    expect(committed.filter((message) => message.role === 'assistant' && message.id === SNAPSHOT_TURN_ID)).toHaveLength(1);
    expect(committed.find((message) => message.id === SNAPSHOT_TURN_ID)?.content)
      .toBe('已经生成的部分，切走期间的后续');

    const finalProjection = projectTurns(committed, 'session-1', false);
    expect(turnText(finalProjection.turns[finalProjection.turns.length - 1]))
      .toBe('已经生成的部分，切走期间的后续');
  });

  it('banner 匹配：按节点归属命中被中断的轮，不误伤其它轮；会话仍在跑时不盖过 drafting', async () => {
    await useSessionStore.getState().switchSession('session-1');
    const snapshot = useSessionStore.getState().streamSnapshot;
    expect(snapshot).not.toBeNull();

    const projection = projectTurns(useSessionStore.getState().messages, 'session-1', true);
    const [firstTurn, interruptedTurn] = projection.turns;

    // 快照 turnId 是 host 现铸的 UUID，投影 turnId 是位置序号 turn-N —— 按 turnId 相等
    // 匹配恒 false（旧 bug）；节点归属匹配能命中真正被中断的那一轮。
    expect(interruptedTurn.turnId).not.toBe(SNAPSHOT_TURN_ID);
    expect(hasIncompleteStreamSnapshot(snapshot, interruptedTurn)).toBe(true);
    expect(hasIncompleteStreamSnapshot(snapshot, firstTurn)).toBe(false);
  });

  it('snapshot 里的在途 toolCalls 随 partial 一起投影成工具节点', async () => {
    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') {
        return {
          success: true,
          data: makeSession(makeSnapshot({
            content: '',
            reasoning: '',
            toolCalls: [{ id: 'tc-1', name: 'Bash', arguments: '{"command":"ls"}' }],
            incompleteToolCallIds: ['tc-1'],
          })),
        };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks') {
        return { success: true, data: [] };
      }
      return { success: false, error: { message: `unexpected domain call: ${action}` } };
    });

    await useSessionStore.getState().switchSession('session-1');
    const projection = projectTurns(useSessionStore.getState().messages, 'session-1', true);
    const toolNode = projection.turns[projection.turns.length - 1].nodes
      .find((node) => node.type === 'tool_call');
    expect(toolNode?.toolCall?.id).toBe('tc-1');
    expect(toolNode?.toolCall?.name).toBe('Bash');
  });

  it('重试锚点不回归：合入 recovery 消息后 deriveRetryTurnMessage 仍锁定触发的用户消息', async () => {
    await useSessionStore.getState().switchSession('session-1');
    const { messages, streamSnapshot } = useSessionStore.getState();
    // 末位已是合入的 assistant partial，但锚点要跳过它拿到 u-2。
    expect(messages[messages.length - 1].id).toBe(SNAPSHOT_TURN_ID);
    expect(deriveRetryTurnMessage(streamSnapshot, messages)?.id).toBe('u-2');
  });

  it('final snapshot 不合入（流已完整落库，DB 消息才是权威）', async () => {
    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') {
        return { success: true, data: makeSession(makeSnapshot({ isFinal: true, streamStatus: 'complete' })) };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks') {
        return { success: true, data: [] };
      }
      return { success: false, error: { message: `unexpected domain call: ${action}` } };
    });

    await useSessionStore.getState().switchSession('session-1');
    expect(useSessionStore.getState().messages.some((message) => message.id === SNAPSHOT_TURN_ID)).toBe(false);
  });
});
