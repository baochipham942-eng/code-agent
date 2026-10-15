// ============================================================================
// ChannelManager 连接失败自动重连测试（N-FEISHU-WS-FIRST-RETRY 验收①②③④）
// ----------------------------------------------------------------------------
// 真 ChannelManager 单例 + 真 FeishuChannel，只把 SDK WSClient 与 dns.lookup
// 换成假件（mock 风格沿用 feishuWsStatus.test.ts）。全程 fake timers，不出网。
// 验收编号对应任务书：①退避重试 ②唤醒/网络恢复/手动断开 ③人话错误 ④三连胜。
// r3 rework：r3-1* 握手期间断开/更新/删除必须赢；r3-2/r3-3 失败按种类分类
// （永久失败停在 error，平台瞬时码退避重试且不显示凭据文案）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelManager } from '../../../src/host/channels/channelManager';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';
import { FEISHU_DEFAULT_HOST } from '../../../src/shared/constants/feishu';

const HANDSHAKE_TIMEOUT_MS = 30_000;
const PROBE_TICK_MS = 5_000;
const ASCII_SENTENCE_PATTERN = /[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){2,}/;

interface WsCtorHandlers {
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
}

const wsCaptures = vi.hoisted(() => ({
  ctor: [] as Array<Record<string, unknown>>,
  clients: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
}));

const lookupMock = vi.hoisted(() => vi.fn(async () => ({ address: '127.0.0.1', family: 4 })));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@larksuiteoapi/node-sdk');
  class WSClient {
    close = vi.fn();
    constructor(opts: Record<string, unknown>) {
      wsCaptures.ctor.push(opts);
      wsCaptures.clients.push(this as unknown as { close: ReturnType<typeof vi.fn> });
    }
    start = vi.fn((_opts: unknown) => Promise.resolve());
  }
  return { ...actual, WSClient };
});

interface StatusEvent {
  status: string;
  message?: string;
}

const statusEvents: StatusEvent[] = [];
let openAccountIds: string[] = [];

function latestCtor(): WsCtorHandlers {
  const ctor = wsCaptures.ctor.at(-1) as WsCtorHandlers | undefined;
  if (!ctor) throw new Error('WSClient was not constructed');
  return ctor;
}

function currentCtorCount(): number {
  return wsCaptures.ctor.length;
}

async function flushAsync(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/** 推进 fake 时钟：期望 delayMs-1 内无新连接尝试，第 delayMs 毫秒恰好出现一个 */
async function expectNextRetryAfter(delayMs: number): Promise<void> {
  const before = currentCtorCount();
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  expect(currentCtorCount(), `no retry before ${delayMs}ms`).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  await flushAsync();
  expect(currentCtorCount(), `retry at ${delayMs}ms`).toBe(before + 1);
}

/** 让当前挂起的握手超时（当前轮连接尝试失败） */
async function failCurrentHandshake(): Promise<void> {
  await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
  await flushAsync();
}

async function addFeishuAccount(manager: ChannelManager): Promise<string> {
  const account = await manager.addAccount('reconnect-test', 'feishu', {
    type: 'feishu',
    appId: 'cli_test',
    appSecret: 'secret-test',
    useWebSocket: true,
  });
  openAccountIds.push(account.id);
  return account.id;
}

function watchStatus(manager: ChannelManager): void {
  manager.on('account_status_change', (accountId: string, status: string, message?: string) => {
    if (openAccountIds.includes(accountId)) {
      statusEvents.push({ status, message });
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  const manager = ChannelManager.getInstance();
  manager.registerPlugin({
    type: 'feishu',
    meta: {
      type: 'feishu',
      name: '飞书',
      description: 'test',
      capabilities: {} as never,
    },
    factory: (id: string) => new FeishuChannel(id),
  });
  watchStatus(manager);
});

afterEach(async () => {
  const manager = ChannelManager.getInstance();
  for (const id of openAccountIds) {
    await manager.disconnectAccount(id).catch(() => undefined);
    await manager.deleteAccount(id).catch(() => undefined);
  }
  openAccountIds = [];
  manager.removeAllListeners('account_status_change');
  statusEvents.length = 0;
  wsCaptures.ctor.length = 0;
  wsCaptures.clients.length = 0;
  lookupMock.mockReset();
  lookupMock.mockImplementation(async () => ({ address: '127.0.0.1', family: 4 }));
  vi.useRealTimers();
});

describe('ChannelManager connect retry', () => {
  it('① enters backoff after first-connect handshake timeout: 30s/60s/120s… capped at 900s, force-closing every failed client', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
    await failCurrentHandshake();
    await first;

    // 失败即入退避：状态 connecting，文案带序号与人话原因
    const account = manager.getAccount(accountId);
    expect(account?.status).toBe('connecting');
    expect(account?.errorMessage).toBe('重连中（第 1 次）：连不上飞书服务器，正在自动重试');

    // 退避序列：30s → 60s → 120s → 240s → 480s → 900s（封顶）
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000]) {
      await expectNextRetryAfter(delay);
      await failCurrentHandshake();
    }

    // 封顶后再来一轮仍是 900s；这一轮挂在握手中（未失败、客户端未关）
    await expectNextRetryAfter(900_000);
    await flushAsync();
    expect(wsCaptures.clients.at(-1)?.close).not.toHaveBeenCalled();

    // 每个失败的客户端都被强关恰好一次，无孤儿连接
    const failedClients = wsCaptures.clients.slice(0, -1);
    expect(failedClients.length).toBeGreaterThanOrEqual(7);
    for (const client of failedClients) {
      expect(client.close).toHaveBeenCalledWith({ force: true });
      expect(client.close).toHaveBeenCalledTimes(1);
    }

    // 每一轮都是新建的 WSClient 实例（clients 互不相同）
    const uniqueClients = new Set(wsCaptures.clients);
    expect(uniqueClients.size).toBe(wsCaptures.clients.length);
  });

  it('②a retries immediately once on system wake, then resumes the backoff', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await failCurrentHandshake();
    await first;
    expect(currentCtorCount()).toBe(1);

    // 系统睡眠 1 小时后醒来：下一个探测 tick 观察到墙钟差，立即重试（不等 30s 退避）
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(PROBE_TICK_MS);
    await flushAsync();
    expect(currentCtorCount()).toBe(2);

    // 立即重试也失败 → 回到退避节奏（第 2 次，60s），而不是清零重来
    await failCurrentHandshake();
    await expectNextRetryAfter(60_000);
  });

  it('②b retries immediately once when DNS lookup flips from failure to success', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);
    lookupMock.mockImplementation(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await failCurrentHandshake();
    await first;
    expect(currentCtorCount()).toBe(1);

    // 首个探测 tick：lookup 失败（记录失败态），探测目标是飞书开放平台域名
    await vi.advanceTimersByTimeAsync(PROBE_TICK_MS);
    expect(lookupMock).toHaveBeenCalledWith(FEISHU_DEFAULT_HOST);

    // 网络恢复：lookup 翻转为成功 → 立即重试（远早于 30s 退避）
    lookupMock.mockImplementation(async () => ({ address: '127.0.0.1', family: 4 }));
    await vi.advanceTimersByTimeAsync(PROBE_TICK_MS);
    await flushAsync();
    expect(currentCtorCount()).toBe(2);

    // 网络恢复触发的重试失败后同样回到退避节奏
    await failCurrentHandshake();
    await expectNextRetryAfter(60_000);
  });

  it('②c never auto-reconnects an account the user manually disconnected', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await failCurrentHandshake();
    await first;
    expect(manager.getAccount(accountId)?.status).toBe('connecting');

    // 手动断开（账号不在 activeChannels、正在退避等待）
    await manager.disconnectAccount(accountId);
    expect(manager.getAccount(accountId)?.status).toBe('disconnected');

    // 推进远超 15 分钟封顶的时间：不再出现任何连接尝试
    await vi.advanceTimersByTimeAsync(1_800_000);
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
  });

  it('③ stores human-language reasons only: no raw SDK English reaches errorMessage', async () => {
    const manager = ChannelManager.getInstance();

    // 路径一：connectAccount catch（握手超时 → 'WebSocket handshake timeout'）
    const timeoutAccount = await addFeishuAccount(manager);
    const timeoutAttempt = manager.connectAccount(timeoutAccount).catch(() => 'failed');
    await failCurrentHandshake();
    await timeoutAttempt;

    const timeoutEvents = statusEvents.filter((event) => event.status === 'error');
    expect(timeoutEvents[0]?.message).toBe('连不上飞书服务器，正在自动重试');
    const timeoutAccountRecord = manager.getAccount(timeoutAccount);
    expect(timeoutAccountRecord?.errorMessage).not.toMatch(ASCII_SENTENCE_PATTERN);
    expect(timeoutAccountRecord?.errorMessage).not.toContain('handshake timeout');
    expect(timeoutAccountRecord?.errorMessage).toContain('重连中（第 1 次）');

    // 路径二：status_change（onError 带 SDK 凭据错误原文）
    const credAccount = await addFeishuAccount(manager);
    const credAttempt = manager.connectAccount(credAccount).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    latestCtor().onError?.(
      new Error('pullConnectConfig failed: code=10003, msg=app secret is invalid'),
    );
    await credAttempt;

    // 所有落进 errorMessage 的文本（含中间 error 态与最终重连态）都不含 SDK 原文
    for (const event of statusEvents) {
      if (event.message === undefined) continue;
      expect(event.message).not.toContain('pullConnectConfig');
      expect(event.message).not.toMatch(ASCII_SENTENCE_PATTERN);
    }
    const credRecord = manager.getAccount(credAccount);
    expect(credRecord?.errorMessage).toContain('飞书应用凭据或权限有误');
    expect(credRecord?.errorMessage).toContain('App ID 和 App Secret');
  });

  it('④ recovers on the third attempt after two timeouts, ending with exactly one live client', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    // 第 1、2 轮握手超时
    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await failCurrentHandshake();
    await first;
    await expectNextRetryAfter(30_000);
    await failCurrentHandshake();

    // 第 3 轮：onReady → 连接成功
    await expectNextRetryAfter(60_000);
    latestCtor().onReady?.();
    await flushAsync();

    expect(manager.getAccount(accountId)?.status).toBe('connected');
    expect(manager.getAccount(accountId)?.errorMessage).toBeUndefined();

    // 三轮共 3 个客户端；前两个失败客户端已强关，仅存活的第 3 个未关
    expect(wsCaptures.clients).toHaveLength(3);
    expect(wsCaptures.clients[0]?.close).toHaveBeenCalledWith({ force: true });
    expect(wsCaptures.clients[1]?.close).toHaveBeenCalledWith({ force: true });
    expect(wsCaptures.clients[2]?.close).not.toHaveBeenCalled();

    // 连上后不再有重试排程（推进很久无新客户端）
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(currentCtorCount()).toBe(3);

    // 成功清零：手动断开后再连失败，从「第 1 次」重新计数
    await manager.disconnectAccount(accountId);
    const again = manager.connectAccount(accountId).catch(() => 'failed');
    await failCurrentHandshake();
    await again;
    expect(manager.getAccount(accountId)?.errorMessage).toContain('重连中（第 1 次）');
  });

  it('r1-1 updateAccount collapses a backoff-waiting account out of connecting before saveAccounts', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    // 首连失败 → 退避等待（不在 activeChannels，状态 connecting/重连中）
    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await failCurrentHandshake();
    await first;
    expect(manager.getAccount(accountId)?.status).toBe('connecting');

    // 用户保存编辑（或关掉 enabled）：取消重试的同时必须把「重连中」收殓成已断开
    await manager.updateAccount(accountId, { name: 'renamed-r1' });
    const account = manager.getAccount(accountId);
    expect(account?.status).toBe('disconnected');
    expect(account?.errorMessage).toBeUndefined();

    // 重试已取消：推进远超封顶时间不再出现连接尝试
    await vi.advanceTimersByTimeAsync(1_800_000);
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
  });

  it('r1-2a passes SDK onReconnecting text through: 「重连中」stays 重连中, not a red connect failure', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await flushAsync();
    latestCtor().onReady?.();
    await first;
    expect(manager.getAccount(accountId)?.status).toBe('connected');

    // 已建立的连接由 SDK 内部自愈重连（onReconnecting）：这是运行态，不是连接失败
    latestCtor().onReconnecting?.();
    await flushAsync();
    const account = manager.getAccount(accountId);
    expect(account?.status).toBe('connecting');
    expect(account?.errorMessage).toBe('重连中');
    // 连接本身还在（activeChannels 不动），SDK onReconnected 后回到 connected
    latestCtor().onReady?.();
    await flushAsync();
    expect(manager.getAccount(accountId)?.status).toBe('connected');
    expect(manager.getAccount(accountId)?.errorMessage).toBeUndefined();
  });

  it('r1-2b takes over an established channel on reconnect-exhausted: dead client closed, backoff retry, back online', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await flushAsync();
    latestCtor().onReady?.();
    await first;
    expect(manager.getAccount(accountId)?.status).toBe('connected');

    // SDK 放弃内部重连（onError 终态）：manager 接管，死实例被强关并按退避重连
    latestCtor().onError?.(new Error('WebSocket reconnect exhausted after 6 attempts'));
    await flushAsync();
    expect(wsCaptures.clients[0]?.close).toHaveBeenCalledWith({ force: true });
    expect(manager.getActiveChannel(accountId)).toBeUndefined();
    const account = manager.getAccount(accountId);
    expect(account?.status).toBe('connecting');
    expect(account?.errorMessage).toBe('重连中（第 1 次）：连不上飞书服务器，正在自动重试');

    // 30s 退避到点重连成功 → 机器人自动回到在线（仅存一个新的活连接）
    await expectNextRetryAfter(30_000);
    latestCtor().onReady?.();
    await flushAsync();
    expect(manager.getAccount(accountId)?.status).toBe('connected');
    expect(wsCaptures.clients).toHaveLength(2);
    expect(wsCaptures.clients[1]?.close).not.toHaveBeenCalled();
  });

  it('r3-1 a manual disconnect during the in-flight handshake wins: the in-flight client is destroyed and a late handshake success never brings the account online', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    // 连接进行中（握手等待期）用户点断开：在飞的握手实例被找到并强关
    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
    await manager.disconnectAccount(accountId);
    expect(manager.getAccount(accountId)?.status).toBe('disconnected');
    expect(wsCaptures.clients[0]?.close).toHaveBeenCalledWith({ force: true });

    // 被销毁实例的握手即使随后成功也不得把账号翻成在线 / 放进活跃表
    latestCtor().onReady?.();
    await first;
    const account = manager.getAccount(accountId);
    expect(account?.status).toBe('disconnected');
    expect(manager.getActiveChannel(accountId)).toBeUndefined();

    // 手动断开后永不自动重连
    await vi.advanceTimersByTimeAsync(1_800_000);
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
  });

  it('r3-1b an update during the in-flight handshake wins: the old-config client is destroyed and a late handshake cannot bring the stale config online', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    // 握手等待期用户保存了新 App Secret：旧凭据的在飞实例必须被销毁
    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await flushAsync();
    await manager.updateAccount(accountId, { config: { appSecret: 'rotated-secret' } });
    expect(manager.getAccount(accountId)?.status).toBe('disconnected');
    expect(wsCaptures.clients[0]?.close).toHaveBeenCalledWith({ force: true });

    // 旧实例的握手随后成功：不得用旧凭据上线
    latestCtor().onReady?.();
    await first;
    expect(manager.getAccount(accountId)?.status).toBe('disconnected');
    expect(manager.getActiveChannel(accountId)).toBeUndefined();
  });

  it('r3-1c deleting an account mid-handshake leaves no channel behind in activeChannels', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await flushAsync();
    await manager.deleteAccount(accountId);
    expect(wsCaptures.clients[0]?.close).toHaveBeenCalledWith({ force: true });

    // 账号已删除：晚到的握手成功不得把死账号的通道留在活跃表里继续收消息
    latestCtor().onReady?.();
    await first;
    expect(manager.getAccount(accountId)).toBeUndefined();
    expect(manager.getActiveChannel(accountId)).toBeUndefined();

    // 已删除账号不排任何重试
    await vi.advanceTimersByTimeAsync(1_800_000);
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
  });

  it('r3-2 permanent failures stop at error without retry: port in use and a rejected token are never replayed', async () => {
    const manager = ChannelManager.getInstance();

    // webhook / HTTP API 端口被占用：换网络也救不回来，重放同一配置没有意义
    const portAccount = await addFeishuAccount(manager);
    const portAttempt = manager.connectAccount(portAccount).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    latestCtor().onError?.(new Error('listen EADDRINUSE: address already in use :::9930'));
    await portAttempt;
    const portRecord = manager.getAccount(portAccount);
    expect(portRecord?.status).toBe('error');
    expect(portRecord?.errorMessage).toBe('本地端口被占用，请检查占用进程或更换端口');

    // 错误的 Telegram token（grammY 401）：停在 error + 人话凭据提示
    const tokenAccount = await addFeishuAccount(manager);
    const tokenAttempt = manager.connectAccount(tokenAccount).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    latestCtor().onError?.(new Error("Call to 'getMe' failed! (401: Unauthorized)"));
    await tokenAttempt;
    const tokenRecord = manager.getAccount(tokenAccount);
    expect(tokenRecord?.status).toBe('error');
    expect(tokenRecord?.errorMessage).toBe('飞书凭据或权限有误，请检查令牌或应用凭据');

    // 永久失败不排退避：推进远超封顶时间，同一份错误配置不再被重放
    await vi.advanceTimersByTimeAsync(1_800_000);
    await flushAsync();
    expect(currentCtorCount()).toBe(2);
  });

  it('r3-3 transient platform codes retry with backoff and never show the credential line: system busy and connection limit', async () => {
    const manager = ChannelManager.getInstance();

    // SDK 对 code=1 (system_busy) 判 retryable:false，但这是平台瞬时忙，不是凭据错
    const busyAccount = await addFeishuAccount(manager);
    const busyAttempt = manager.connectAccount(busyAccount).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    latestCtor().onError?.(new Error('pullConnectConfig failed: code=1, msg=system busy'));
    await busyAttempt;
    const busyRecord = manager.getAccount(busyAccount);
    expect(busyRecord?.status).toBe('connecting');
    expect(busyRecord?.errorMessage).toBe('重连中（第 1 次）：连不上飞书服务器，正在自动重试');
    expect(busyRecord?.errorMessage).not.toContain('App ID');

    // 平台恢复后按退避重连成功 → 账号自动回在线
    await expectNextRetryAfter(30_000);
    latestCtor().onReady?.();
    await flushAsync();
    expect(manager.getAccount(busyAccount)?.status).toBe('connected');

    // code=1000040350 (exceed_conn_limit)：连接数超限单独说明，不提示改 App Secret
    const limitAccount = await addFeishuAccount(manager);
    const limitAttempt = manager.connectAccount(limitAccount).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    latestCtor().onError?.(new Error('pullConnectConfig failed: code=1000040350, msg=exceed connection limit'));
    await limitAttempt;
    const limitRecord = manager.getAccount(limitAccount);
    expect(limitRecord?.status).toBe('connecting');
    expect(limitRecord?.errorMessage).toBe('重连中（第 1 次）：飞书连接数已达上限，正在自动重试');
    expect(limitRecord?.errorMessage).not.toContain('App Secret');

    // 连接数降下来后同样按退避自动重连
    await expectNextRetryAfter(30_000);
    latestCtor().onReady?.();
    await flushAsync();
    expect(manager.getAccount(limitAccount)?.status).toBe('connected');
  });

  it('r1-3 credential failures never enter the backoff: no replay of a bad App Secret', async () => {
    const manager = ChannelManager.getInstance();
    const accountId = await addFeishuAccount(manager);

    const first = manager.connectAccount(accountId).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    latestCtor().onError?.(
      new Error('pullConnectConfig failed: code=10003, msg=app secret is invalid'),
    );
    await first;

    // 停在 error + 人话凭据提示，而不是「重连中」
    const account = manager.getAccount(accountId);
    expect(account?.status).toBe('error');
    expect(account?.errorMessage).toBe('飞书应用凭据或权限有误，请检查 App ID 和 App Secret');

    // SDK 判定不可重试的失败不排退避：推进远超封顶时间，同一份错误凭据不再被重放
    await vi.advanceTimersByTimeAsync(1_800_000);
    await flushAsync();
    expect(currentCtorCount()).toBe(1);
  });
});
