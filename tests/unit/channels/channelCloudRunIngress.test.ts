// ============================================================================
// ADR-087 S4B：服务模式下通道入站经云端账本（真 sqlite 账本 + 生产装配）。
// - ① 同一 delivery 重放：不添行、轮次只跑一次（跨 bridge 实例，模拟重启后
//   内存去重失效，只有账本幂等键在挡）。
// - ② 2 槽占满 → 第三条排队：提示恰一条；槽释放后提升轮从 request_json
//   还原、经 executeChannelRun 真跑、回复送达、行收 succeeded（不落 failed）。
// - ③ guest 消息与桌面态（无端口）不进账本，本地路径不变。
// - ④ 账号未就绪：恰一条白话回复，本地什么都不跑，账本无行。
// - r1-A 语音消息：转写块必须拼进云端轮次的 prompt（与桌面路径同形）。
// - r1-B 重推撞上 sweep 打断的行（interrupted，从未执行）：补跑补回复，
//   不再静默吞掉（桌面重启后内存去重清零本来就会重跑）。
// - r1-C 排队等待者等到的终态是 interrupted：同样就地补跑，不标已处理。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => taskManager,
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => channelManager,
}));

// 语音转写只桩结果（真实链路在 audioTranscriptionService 自己的测试里）；
// 该模块的运行时导出只有 transcribeAudioFile 且仅桥消费，定向 mock 安全。
const transcribeAudioFileMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/media/audioTranscriptionService', () => ({
  transcribeAudioFile: transcribeAudioFileMock,
}));

// guest 路径会真调 getAllToolDefinitions（真实工具面太重，照 eventFilter 测试 mock）。
vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [
    { name: 'Read', permissionLevel: 'read', source: 'builtin' },
    { name: 'Bash', permissionLevel: 'execute', source: 'builtin' },
  ],
}));

import type { ChannelMessage } from '../../../src/shared/contract/channel';
import { ChannelAgentBridge, initChannelAgentBridge } from '../../../src/host/channels/channelAgentBridge';
import { setChannelCloudRunPort } from '../../../src/host/channels/channelCloudRunPort';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createCloudRunLedger, type CloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import { CloudRunRouteRuntime } from '../../../src/web/routes/cloudRunRoutes';
import { wireChannelCloudRun } from '../../../src/web/routes/cloudChannelRun';
import { applySchema } from '../../../src/host/services/core/database/schema';
import type { IngressMessage } from '../../../src/host/channels/ingressPipeline';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const sessionManager = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

function makeOrchestrator() {
  const messages: Array<{ role: string; content: string }> = [];
  return {
    getMessages: () => [...messages],
    sendMessage: vi.fn(async (content: string) => {
      messages.push({ role: 'assistant', content: `reply:${content}` });
    }),
    isProcessing: () => false,
    setWorkingDirectory: vi.fn(),
  };
}

const taskManager = vi.hoisted(() => {
  const orchestrators = new Map<string, ReturnType<typeof makeOrchestrator>>();
  return {
    getOrchestrator: (sessionId?: string) => (sessionId ? orchestrators.get(sessionId) : undefined),
    setSessionContext: vi.fn(),
    getOrCreateCurrentOrchestrator: (sessionId?: string) => {
      const key = sessionId ?? 'default';
      if (!orchestrators.has(key)) orchestrators.set(key, makeOrchestrator());
      return orchestrators.get(key)!;
    },
    orchestrators,
  };
});

const sendText = vi.hoisted(() => vi.fn(async () => ({ success: true })));

const channelManager = vi.hoisted(() => ({
  getAccount: () => ({ id: 'account-1', name: 'Feishu', type: 'feishu' }),
  getResponseCallback: () => ({ sendText }),
  sendErrorResponse: vi.fn(async () => ({ success: true })),
}));

interface BindingKey {
  accountId: string;
  chatId: string;
  threadId: string;
  ingressAuth: string;
}

function createBindingStore() {
  const bindings = new Map<string, string>();
  const key = (k: BindingKey) => JSON.stringify([k.accountId, k.chatId, k.threadId, k.ingressAuth]);
  return {
    get: (k: BindingKey) => bindings.get(key(k)),
    set: (k: BindingKey, sessionId: string) => bindings.set(key(k), sessionId),
    delete: (k: BindingKey) => { bindings.delete(key(k)); },
  };
}

const configService = {
  getSettings: () => ({ model: {}, ui: { language: 'zh-CN' } }),
};

function createMessage(chatId: string, messageId: string, extra?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: messageId,
    channelId: 'feishu-1',
    sender: { id: 'sender-1', name: 'Sender' },
    context: { chatId, chatType: 'p2p' },
    content: `hello from ${chatId}`,
    timestamp: 1,
    ingressAuth: 'paired',
    ...extra,
  };
}

/** 复刻 handleChannelMessage 的暂存动作后直接驱动 pipeline 回调（跳过 debounce 计时器）。 */
async function ingress(bridge: ChannelAgentBridge, accountId: string, message: ChannelMessage): Promise<void> {
  const sessionKey = JSON.stringify([
    accountId,
    message.context.chatId,
    message.context.threadId ?? '',
    message.ingressAuth ?? 'paired',
  ]);
  const ingressKey = `${sessionKey}:${message.id}`;
  (bridge as unknown as {
    pendingChannelMessages: Map<string, { accountId: string; message: ChannelMessage }>;
  }).pendingChannelMessages.set(ingressKey, { accountId, message });
  await (bridge as unknown as { processIngressMessage(msg: IngressMessage): Promise<void> }).processIngressMessage({
    sessionKey,
    content: message.content,
    timestamp: message.timestamp,
    metadata: { accountId, messageId: message.id, ingressKey },
    parts: [{
      messageId: message.id,
      content: message.content,
      timestamp: message.timestamp,
      metadata: { accountId, ingressKey },
    }],
  });
}

function allTurns(): unknown[][] {
  return [...taskManager.orchestrators.values()].flatMap((orchestrator) => orchestrator.sendMessage.mock.calls);
}

function cloudRunRows(db: BetterSqlite3.Database): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT run_id, "trigger", state, channel_delivery_id FROM cloud_runs ORDER BY created_at, rowid')
    .all() as Array<Record<string, unknown>>;
}

describe('channel ingress through the cloud run ledger (service mode)', () => {
  let db: BetterSqlite3.Database;
  let ledger: CloudRunLedger;
  let accountId: string | null;
  let runtime: CloudRunRouteRuntime;
  // 提升轮经 executeChannelRun 找单例桥；各测试的入站桥与单例桥共享同一份绑定。
  const sharedBindingStore = createBindingStore();

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger as unknown as Parameters<typeof applySchema>[1]);
    accountId = 'acct_a';
    ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    const runRegistry = new RunRegistry();
    // 生产同构装配：先注册端口（直连账本，与 agent.ts 同形），再把 executeChannelRun 交给 runtime。
    const wired = wireChannelCloudRun({ getLedger: () => ledger, logger: logger as never });
    runtime = new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry,
      execute: async () => {},
      executeChannelRun: wired.executeChannelRun,
      logger: logger as never,
    });
    // 挂 transition listener（生产由启动 sweep 首调 runtime.ledger() 挂上）。
    runtime.ledger();
    initChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    sendText.mockClear();
    channelManager.sendErrorResponse.mockClear();
    taskManager.setSessionContext.mockClear();
    taskManager.orchestrators.clear();
    sessionManager.createSession.mockReset();
    sessionManager.createSession.mockImplementation(async () => ({ id: `session-${sessionManager.createSession.mock.calls.length}` }));
    sessionManager.getSession.mockReset();
    sessionManager.getSession.mockImplementation(async (sessionId: string) => ({ id: sessionId, messages: [] }));
    transcribeAudioFileMock.mockReset();
  });

  afterEach(() => {
    setChannelCloudRunPort(null);
    db.close();
  });

  it('① admits a channel message and replays the same delivery without a second row or turn', async () => {
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    await ingress(bridge, 'account-1', createMessage('chat-1', 'om_1'));

    const rows = cloudRunRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: 'channel',
      state: 'succeeded',
      channel_delivery_id: 'account-1:om_1',
    });
    // N-CHANNEL-REPLY-BREVITY 并入后每轮多一条开跑回执：ack + reply = 2。
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenNthCalledWith(1, '收到，开始处理：hello from chat-1');
    expect(sendText).toHaveBeenCalledWith('reply:hello from chat-1');
    expect(allTurns()).toHaveLength(1);

    // 重放 = 全新 bridge 实例（内存去重清零，模拟重启后平台重推）：账本幂等键接住。
    const replayBridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    await ingress(replayBridge, 'account-1', createMessage('chat-1', 'om_1'));

    expect(cloudRunRows(db)).toHaveLength(1);
    expect(ledger.getRun(rows[0].run_id as string)?.state).toBe('succeeded');
    expect(allTurns()).toHaveLength(1);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('② queues the third chat behind 2 busy slots, hints once, then replies from the promoted run', async () => {
    // 两条 manual 行占满在飞（running 行不触发提升）。
    ledger.admit({ sessionId: 'session_busy_1', trigger: 'manual', requestJson: JSON.stringify({ prompt: 'busy1' }) });
    ledger.admit({ sessionId: 'session_busy_2', trigger: 'manual', requestJson: JSON.stringify({ prompt: 'busy2' }) });

    // 不 await：排队路径会等提升轮收线才返回，槽位要由测试在后面释放。
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    const ingressPromise = ingress(bridge, 'account-1', createMessage('chat-queued', 'om_q'));
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));

    const queued = cloudRunRows(db).find((row) => row.trigger === 'channel');
    expect(queued).toMatchObject({ state: 'queued', channel_delivery_id: 'account-1:om_q' });
    expect(sendText).toHaveBeenCalledWith(expect.stringContaining('第 1 位'));
    expect(allTurns()).toHaveLength(0);

    // 释放一个槽：终态迁移触发提升 → executeChannelRun 从 request_json 还原执行。
    const firstManual = cloudRunRows(db).find((row) => row.trigger === 'manual')!;
    ledger.transition(firstManual.run_id as string, 'succeeded');
    await ingressPromise;
    await vi.waitFor(() => expect(ledger.getRun(queued!.run_id as string)?.state).toBe('succeeded'));

    // cloudQueued 提示 1 + 提升轮开跑回执 1 + 终稿 1 = 3（回执来自 N-CHANNEL-REPLY-BREVITY）。
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText).toHaveBeenLastCalledWith('reply:hello from chat-queued');
    expect(ledger.getRun(queued!.run_id as string)?.state).not.toBe('failed');
  });

  it('③ keeps guest messages off the ledger and keeps desktop mode (no port) on the local path', async () => {
    // guest：端口在也不进账本，本地照跑。
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    await ingress(bridge, 'account-1', createMessage('chat-guest', 'om_g', { ingressAuth: 'guest' }));
    expect(cloudRunRows(db)).toHaveLength(0);
    expect(allTurns()).toHaveLength(1);

    // 桌面态：无端口，paired 消息也走本地路径。
    setChannelCloudRunPort(null);
    sendText.mockClear();
    taskManager.orchestrators.clear();
    await ingress(new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never), 'account-1', createMessage('chat-desktop', 'om_d'));
    expect(cloudRunRows(db)).toHaveLength(0);
    expect(allTurns()).toHaveLength(1);
    expect(sendText).toHaveBeenCalledWith('reply:hello from chat-desktop');
  });

  it('④ replies exactly once and runs nothing locally when the cloud account is missing', async () => {
    accountId = null;
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    await ingress(bridge, 'account-1', createMessage('chat-noauth', 'om_n'));

    expect(cloudRunRows(db)).toHaveLength(0);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(expect.stringContaining('云端账号还没就绪'));
    expect(allTurns()).toHaveLength(0);
    expect(channelManager.sendErrorResponse).not.toHaveBeenCalled();
  });

  it('r1-A splices the voice transcript into the cloud turn prompt (parity with the desktop path)', async () => {
    transcribeAudioFileMock.mockResolvedValue({ ok: true, text: 'meeting at three pm today', engine: 'stub' });
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    // 语音消息：正文为空，可说的全在附件转写里（paired 通道的典型形状）。
    await ingress(bridge, 'account-1', createMessage('chat-voice', 'om_v', {
      content: '',
      attachments: [{
        id: 'att-1', type: 'audio', name: 'voice.ogg', mimeType: 'audio/ogg', localPath: '/tmp/voice.ogg',
      }],
    }));

    expect(transcribeAudioFileMock).toHaveBeenCalledTimes(1);
    const turns = allTurns();
    expect(turns).toHaveLength(1);
    const promptContent = turns[0][0] as string;
    expect(promptContent).toContain('语音转写');
    expect(promptContent).toContain('meeting at three pm today');
    // 回帖同样带转写内容（假 orchestrator 原样回显 prompt）。
    expect(sendText).toHaveBeenCalledWith(expect.stringContaining('meeting at three pm today'));
    expect(ledger.getRun(cloudRunRows(db)[0].run_id as string)?.state).toBe('succeeded');
  });

  it('r1-B re-runs the turn when a redelivery matches a row the startup sweep interrupted', async () => {
    // 前一进程：om_i 已 admit 成 running，重启后 startupSweep 对未 bind 执行体的
    // 在飞行收 interrupted（通道行从不 bind）——sweep 的机制就是这条 transition。
    const prior = ledger.admit({
      sessionId: 'session-prior',
      trigger: 'channel',
      channelDeliveryId: 'account-1:om_i',
      requestJson: JSON.stringify({ accountId: 'account-1', message: { id: 'om_i' }, partIds: ['om_i'] }),
    });
    ledger.transition(prior.record.runId, 'interrupted');

    // 平台重推同一消息 id：全新 bridge 实例（内存去重清零），只有账本幂等键在挡。
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    await ingress(bridge, 'account-1', createMessage('chat-r1b', 'om_i'));

    expect(cloudRunRows(db)).toHaveLength(1); // 幂等键接住，不添行
    expect(allTurns()).toHaveLength(1); // 但轮次补跑：消息不再被吞
    // 开跑回执（N-CHANNEL-REPLY-BREVITY）+ 补跑终稿 = 2。
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledWith('reply:hello from chat-r1b');
    // 终态无出边：补跑后的 settle 幂等跳过，行保持 interrupted（对首次尝试是如实记录）。
    expect(ledger.getRun(prior.record.runId)?.state).toBe('interrupted');
  });

  it('r1-C re-runs inline when the awaited queued row ends interrupted instead of replying', async () => {
    ledger.admit({ sessionId: 'session_busy_1', trigger: 'manual', requestJson: JSON.stringify({ prompt: 'busy1' }) });
    ledger.admit({ sessionId: 'session_busy_2', trigger: 'manual', requestJson: JSON.stringify({ prompt: 'busy2' }) });

    // 不 await：排队分支持会话锁等提升轮收线。
    const bridge = new ChannelAgentBridge({ configService, bindingStore: sharedBindingStore } as never);
    const ingressPromise = ingress(bridge, 'account-1', createMessage('chat-r1c', 'om_w'));
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(sendText).toHaveBeenCalledWith(expect.stringContaining('第 1 位'));

    const queuedRow = cloudRunRows(db).find((row) => row.trigger === 'channel')!;
    // 提升（queued→running）后进程内 sweep 把未 bind 的在飞行打断：等待者等到的
    // 终态是 interrupted，不是任何真实回复。
    ledger.transition(queuedRow.run_id as string, 'running');
    ledger.transition(queuedRow.run_id as string, 'interrupted');
    await ingressPromise;

    expect(allTurns()).toHaveLength(1); // 就地补跑，不把这条消息标成已处理
    expect(sendText).toHaveBeenLastCalledWith('reply:hello from chat-r1c');
    expect(ledger.getRun(queuedRow.run_id as string)?.state).toBe('interrupted');
  });
});
