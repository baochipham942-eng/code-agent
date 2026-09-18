import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import { createCompanionStore } from '../../../packages/mobile/src/stores/companionStore';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';

/**
 * N-MOBILE-RELAY-PHONE 双径策略的 store 形态（照 mdnsReconnect.test.ts 的替身法）：
 * LAN 直连优先，失败且有缓存路由才落 relay；LAN 恢复时收敛回直连，不双跑；
 * relay 面上听写/推送按「主机不支持」降级。传输两侧全部 mock，这里只测 store 的选择。
 * FB-197 起拨号并行竞速（先成者胜）：lanGate/relayGate 是各自的手动闸，控「谁先通」。
 */
const harness = vi.hoisted(() => ({
  lanError: null as string | null,
  /** 旧 Host 形态：exchange 不认识 relay.route ⇒ 关 channel（真机首验 2026-09-15 的现场）。 */
  oldHost: false,
  relayError: null as string | null,
  relayClosed: 0,
  relayConstructed: 0,
  onRevoked: null as null | (() => void),
  relayRequests: [] as Record<string, unknown>[],
  lanRequests: [] as Record<string, unknown>[],
  /** O2：sync 挂起待撤销帧（真客户端里 revoke 帧 drop 等待者先于 onRevoked）。 */
  hangSync: false,
  rejectSync: null as null | ((error: Error) => void),
  relayDials: [] as { url: string; authorization: string }[],
  /** LAN recover 回的 binding 是否带 dictation 广告（含百炼三态）。 */
  dictationAdvertised: false,
  dictationOpenResult: null as null | { ok: boolean; streamId?: string; sampleRate?: number },
  /** 每个 mock LAN 客户端实例的存活标记——断言「会话通道没陪葬」用。 */
  lanClients: [] as { alive: boolean }[],
  /** N-MOBILE-NOHOST-WAKING-STATE：下一笔 relay connect() 挂起（一次性），releaseRelay 注入迟到结局。 */
  hangRelayOnce: false,
  releaseRelay: null as null | ((code: string) => void),
  /** 竞速计时（FB-197）：recover / relay connect 的手动闸——null = 不挂，立即走罐头逻辑。 */
  lanGate: null as Promise<unknown> | null,
  relayGate: null as Promise<unknown> | null,
  /** relay 面补投 command 的回包状态：'accepted' 正常闭环；'reconciling' = 命令在途（槽驻留）。 */
  relayCommandState: 'accepted' as string,
  /** R4 Nit②：relay 面补投 command 挂起（一次性），releaseRelayCommand 注入回包状态。 */
  hangRelayCommandOnce: false,
  releaseRelayCommand: null as null | ((state: string) => void),
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    private readonly ref = { alive: true };
    constructor() { harness.lanClients.push(this.ref); }
    async pair() { throw new Error('unused'); }
    async recover() {
      if (harness.lanGate) await harness.lanGate;
      // close 过的客户端 recover 不再出结果：真客户端靠 generation 抛 CHANNEL_CHANGED。
      if (!this.ref.alive) throw new Error('COMPANION_CHANNEL_CHANGED');
      if (harness.lanError) throw new Error(harness.lanError);
      return { version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32),
        deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'],
        ...(harness.dictationAdvertised ? { dictation: true as const, dictationTranscription: 'no-key' as const } : {}) };
    }
    async request(payload: Record<string, unknown>) {
      if (!this.ref.alive) throw new Error('COMPANION_NOT_CONNECTED');
      harness.lanRequests.push(payload);
      if (payload.action === 'status') return null;
      if (payload.action === 'dictation' && payload.op === 'open') {
        return harness.dictationOpenResult ?? { ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE', events: [] };
      }
      if (payload.action === 'relay.route') {
        if (harness.oldHost) {
          // 旧 Host：未知动作 ⇒ 服务端关 channel，客户端 self-close——这条通道从此死透。
          this.ref.alive = false;
          throw new Error('COMPANION_NETWORK_UNAVAILABLE');
        }
        return { kind: 'ok', v: 1, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };
      }
      if (payload.action === 'relay.routes') {
        // 探针先问 relay.routes（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE）。这个替身 Host 没登录
        // 账号：只回旧路由。旧 Host 两个动作都不认识——通道照关。
        if (harness.oldHost) {
          this.ref.alive = false;
          throw new Error('COMPANION_NETWORK_UNAVAILABLE');
        }
        return { kind: 'ok', routes: { v: 1, legacy: { v: 1, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' } } };
      }
      if (payload.action === 'command') {
        // 结算回执：原样回带命令身份（companionAckMatches 按 commandId/deviceId/sessionId/action 认人）。
        return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: 'accepted', result: {} } };
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() { this.ref.alive = false; }
  },
}));

vi.mock('../../../packages/mobile/src/platform/relayCompanionClient', () => ({
  browserRelayDial: () => { throw new Error('test must inject dialRelay'); },
  RelayCompanionClient: class {
    private closed = false;
    /** close 的分类码照真客户端（relayCompanionClient.close）：握手没谈完、一个帧都没收到 ⇒
     *  AUTH_REJECTED——竞速赢方关在途拨号时 wrapper 若照字面兑现会作废好票据/回落再拨，
     *  mock 必须把这条分类带出来，否则 store 侧的防护在测试里不可见。 */
    private closeCode: string | null = null;
    private established = false;
    constructor(deps: { onRevoked?: () => void; dial: (url: string, headers: { authorization: string }) => unknown }) {
      harness.relayConstructed += 1;
      harness.onRevoked = deps.onRevoked ?? null;
      // store 会把 port.dialRelay 传进来；借构造把拨号参数记下来。
      deps.dial('capture://dial', { authorization: '' });
    }
    async connect() {
      if (harness.relayGate) await harness.relayGate;
      // 被赢方/抢占者 close 过的拨号：继续走只会留第二条活通道，立即失败。
      if (this.closed) throw new Error(this.closeCode ?? 'COMPANION_NOT_CONNECTED');
      harness.relayDials.push({ url: 'captured-in-store-test', authorization: 'n/a' });
      if (harness.hangRelayOnce) {
        harness.hangRelayOnce = false;
        return new Promise<void>((_, reject) => { harness.releaseRelay = code => reject(new Error(code)); });
      }
      if (harness.relayError) throw new Error(harness.relayError);
    }
    async resume() {
      if (this.closed) throw new Error(this.closeCode ?? 'COMPANION_NOT_CONNECTED');
      if (harness.relayError) throw new Error(harness.relayError);
      this.established = true;
    }
    async request(payload: Record<string, unknown>) {
      harness.relayRequests.push(payload);
      if (payload.action === 'sync' && harness.hangSync) {
        return new Promise((_, reject) => { harness.rejectSync = reject; });
      }
      if (payload.action === 'sync') return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
      // 结算查询/补投与 LAN 面同形（status 查无记录 ⇒ 补投；command 原样带回命令身份，
      // companionAckMatches 按 commandId/deviceId/sessionId/action 认人）。
      if (payload.action === 'status') return null;
      if (payload.action === 'command') {
        if (harness.hangRelayCommandOnce) {
          harness.hangRelayCommandOnce = false;
          return new Promise(resolve => { harness.releaseRelayCommand = state => resolve({ kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state, result: {} } }); });
        }
        return { kind: 'accepted', command: { ...(payload.command as Record<string, unknown>), state: harness.relayCommandState, result: {} } };
      }
      return { kind: 'accepted', command: { commandId: 'x', state: 'accepted', result: {} } };
    }
    close() {
      this.closed = true;
      this.closeCode = this.established ? 'COMPANION_NOT_CONNECTED' : 'COMPANION_RELAY_AUTH_REJECTED';
      harness.relayClosed += 1;
    }
  },
}));

const identity = createIdentity();
const RELAY_ROUTE = { v: 1 as const, url: 'ws://127.0.0.1:8791/', routeToken: 'route-token-aaaaaa', credential: 'relay-shared-credential' };
/** 竞速③的配对盘里带一条待确认命令：结算（status/deliver）只在最终胜出的通道上跑。 */
const PENDING_COMMAND = { version: 1, deviceId: 'phone-1', scopeEpoch: 1, commandId: 'cmd-race-3', sessionId: 'shared', action: 'message.send', payload: { text: '竞速期间卡住的' } } as const;

function storageWith(options: { relay?: unknown; pending?: unknown; relayAccount?: unknown; account?: unknown } = {}) {
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: { version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: 'aa'.repeat(32), deviceId: 'phone-1', scopeEpoch: 1, scope: ['shared'] },
    ...(options.relay === undefined ? {} : { relay: options.relay }),
    ...(options.pending === undefined ? {} : { pending: options.pending }),
    ...(options.relayAccount === undefined ? {} : { relayAccount: options.relayAccount }),
    ...(options.account === undefined ? {} : { account: options.account }),
  });
}

function storeWith(raw: string) {
  const companion: NonNullable<PlatformPorts['companion']> = {
    read: async () => raw,
    write: async () => {},
    scan: async () => { throw new Error('unused'); },
    post: async () => ({}),
    dialRelay: () => ({ send: () => {}, close: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} }),
  };
  return createCompanionStore(companion, () => {});
}

describe('companionStore 双径：LAN 优先、relay 回落、恢复收敛', () => {
  it('LAN 失败 + 有缓存路由 ⇒ 落 relay：connected 且 transport=relay', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null; harness.relayConstructed = 0; harness.relayClosed = 0;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(harness.relayConstructed).toBe(1);
    store.getState().pause();
  });

  it('LAN 失败 + relay 也失败 ⇒ offline，relay 失败码可分类', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = 'COMPANION_RELAY_UNAVAILABLE';
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayUnavailable', transport: null });
    harness.relayError = 'COMPANION_RELAY_AUTH_REJECTED';
    const other = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await other.getState().hydrate();
    expect(other.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayRejected' });
    // NO_HOST 那拍按 N-MOBILE-NOHOST-WAKING-STATE 改写：不再当场 offline——先进「等电脑上线」
    // 过渡态，15s 到点才落回同一句失败码（断言不删，只是搬到它现在该在的时刻）。
    harness.relayError = 'COMPANION_RELAY_NO_HOST';
    vi.useFakeTimers();
    try {
      const noHost = storeWith(storageWith({ relay: RELAY_ROUTE }));
      await noHost.getState().hydrate();
      expect(noHost.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true, connectionError: null });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(noHost.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayNoHost' });
    } finally { vi.useRealTimers(); }
  });

  it('LAN 失败 + 没有缓存路由 ⇒ 只报 LAN 的错误（行为不劣化）', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null; harness.relayConstructed = 0;
    const store = storeWith(storageWith());
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable' });
    expect(harness.relayConstructed).toBe(0);
  });

  it('LAN 恢复 ⇒ 收敛回直连，relay 客户端被关掉（不双跑）', async () => {
    harness.relayClosed = 0;
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState().transport).toBe('relay');
    harness.lanError = null;
    await store.getState().reconnect();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(harness.relayClosed).toBeGreaterThan(0);
    store.getState().pause();
  });

  it('relay 连接期间听写与推送按「主机不支持」降级，不把请求发出去', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null; harness.relayRequests = [];
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(await store.getState().dictationOpen()).toMatchObject({ ok: false, code: 'COMPANION_DICTATION_UNAVAILABLE' });
    expect(await store.getState().registerPush({ provider: 'apns', token: 't', environment: 'production' }))
      .toMatchObject({ kind: 'rejected', reason: 'unsupported_action' });
    await store.getState().openRoute('route-token');
    expect(store.getState().routeError).toBe('unsupported_action');
    expect(harness.relayRequests.map(payload => payload.action)).not.toContain('dictation');
    expect(harness.relayRequests.map(payload => payload.action)).not.toContain('push.register');
    expect(harness.relayRequests.map(payload => payload.action)).not.toContain('push.open');
    store.getState().pause();
  });

  it('relay 面的 onRevoked 把设备翻成 rejected（revoke 帧路径的 store 接线）', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(harness.onRevoked).toBeTruthy();
    harness.onRevoked?.();
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected', transport: null });
  });

  it('撤销时有 sync 在飞（revoke 帧先 drop 再 onRevoked）：rejected 不被打回 offline、不闪自动重试（O2）', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = null;
    harness.hangSync = true;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    // 记录撤销之后看到的每拍（status, autoRetrying）：序列里不许出现 autoRetrying=true。
    const seen: { status: string; autoRetrying: boolean }[] = [];
    const unsubscribe = store.subscribe(state => seen.push({ status: state.status, autoRetrying: state.autoRetrying }));
    const syncing = store.getState().sync();          // 这条 sync 挂起（宿主正在撤销）
    await new Promise(resolve => setTimeout(resolve, 0));
    // 真客户端的顺序：drop() 先结算等待者（sync 失败），同一帧里 onRevoked 把设备翻成 rejected。
    const settleSync = harness.rejectSync;
    if (!settleSync) throw new Error('sync 未挂起：rejectSync 缺失');
    settleSync(new Error('COMPANION_DEVICE_REVOKED'));
    harness.onRevoked?.();
    await syncing;
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected' });
    expect(seen.filter(state => state.autoRetrying)).toEqual([]);
    unsubscribe();
    store.getState().pause();
    harness.hangSync = false; harness.rejectSync = null;
  });

  it('配对盘里坏掉的 relay 路由被丢弃，配对身份不受连累', async () => {
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayConstructed = 0;
    const store = storeWith(storageWith({ relay: { v: 2, url: 'not a url', routeToken: 'x', credential: 'short' } }));
    await store.getState().hydrate();
    // 路由被丢 ⇒ 没有 relay 可落，报的还是 LAN 的错误，且配对身份照常可恢复。
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionUnavailable' });
    expect(harness.relayConstructed).toBe(0);
  });

  it('LAN 连着时刷新到新 routeToken 会写回配对盘', async () => {
    harness.lanError = null; harness.lanRequests = []; harness.oldHost = false;
    const writes: string[] = [];
    const companion: NonNullable<PlatformPorts['companion']> = {
      read: async () => storageWith({ relay: RELAY_ROUTE }),
      write: async value => { writes.push(value); },
      scan: async () => { throw new Error('unused'); },
      post: async () => ({}),
      dialRelay: () => ({ send: () => {}, close: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {}, onMessage: () => {} }),
    };
    const store = createCompanionStore(companion, () => {});
    await store.getState().hydrate();
    // mock 的 relay.routes 永远回同一个 token ⇒ hydrate 重连走 LAN 时会请求一次路由（探针先问双路由）。
    expect(harness.lanRequests.map(payload => payload.action)).toContain('relay.routes');
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.parse(writes.at(-1) ?? '{}').relay).toMatchObject({ routeToken: 'route-token-aaaaaa' });
    store.getState().pause();
  });

  it('旧 Host 把 relay.route 当未知动作关 channel：会话通道不陪葬（真机首验回归）', async () => {
    harness.lanError = null; harness.oldHost = true; harness.lanClients = []; harness.lanRequests = [];
    const store = storeWith(storageWith());
    await store.getState().hydrate();
    // LAN 恢复成功、路由探针被旧 Host 拒杀——但状态仍是 connected、会话通道还活着。
    // 探针（N-COMPANION-RELAY-ACCOUNT-ROUTE-PHONE 起）先问 relay.routes、被拒杀后回落问一次
    // relay.route、同样被拒杀——旧 Host 两个动作都不认识，死的都只是探针。
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    expect(harness.lanClients.length).toBe(3); // 主通道 + relay.routes 探针 + relay.route 回落探针
    expect(harness.lanClients[0].alive).toBe(true); // 主通道没陪葬
    expect(harness.lanClients[1].alive).toBe(false); // 死的只是探针
    expect(harness.lanClients[2].alive).toBe(false); // 回落探针同样只死自己
    // 首验现场正是这里：路由一问把会话通道打死，首次 sync 即掉线报「电脑没回应」。
    await store.getState().sync();
    expect(store.getState()).toMatchObject({ status: 'connected' });
    await store.getState().send('old-host-正文');
    expect(store.getState()).toMatchObject({ status: 'connected', pending: false });
    store.getState().pause();
  });

  // N-MOBILE-VOICE-TRANSCRIBE-FIX-R6 ai-review Important 的收尾链：中继/长连不刷新就绪三态，
  // 实时听写真开起来了就把 binding 的百炼三态就地追上，否则「开好了，再试一次」只放行一次。
  it('实时听写 open 成功：binding.dictationTranscription 就地追成 ready', async () => {
    harness.lanError = null; harness.oldHost = false;
    harness.dictationAdvertised = true;
    harness.dictationOpenResult = { ok: true, streamId: 'stream-1', sampleRate: 16000 };
    try {
      const store = storeWith(storageWith());
      await store.getState().hydrate();
      expect(store.getState().binding).toMatchObject({ dictation: true, dictationTranscription: 'no-key' });
      await store.getState().dictationOpen();
      expect(store.getState().binding).toMatchObject({ dictation: true, dictationTranscription: 'ready' });
      store.getState().pause();
    } finally {
      harness.dictationAdvertised = false;
      harness.dictationOpenResult = null;
    }
  });
});

/**
 * N-MOBILE-NOHOST-WAKING-STATE：手机经中继拨到 no-host 不直接落失败页——store 层进「等电脑上线」
 * 过渡态，每 3s 重拨一次，15s 内电脑上线直接连上（全程无失败闪态），到点才落回 connectionRelayNoHost。
 * 全部用 fake timers 驱动节拍；harness 的 relayConstructed/relayError 记账用来数拨号与翻转结局。
 */
describe('no-host 过渡态：等电脑上线，15s 内不落失败页', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    harness.relayError = 'COMPANION_RELAY_NO_HOST';
    harness.relayConstructed = 0;
    harness.hangRelayOnce = false;
    harness.releaseRelay = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    harness.lanError = null;
    harness.relayError = null;
  });

  it('① NO_HOST 不落失败页：进过渡态（connecting + 等待标记 + connectionError 保持 null），死线内怎么拨都不 offline', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const samples: { status: string; connectionError: string | null }[] = [];
    const unsubscribe = store.subscribe(s => samples.push({ status: s.status, connectionError: s.connectionError }));
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ status: 'connecting', connectionError: null, transport: null, relayNoHostWaiting: true, busy: false });
    expect(harness.relayConstructed).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().relayNoHostWaiting).toBe(true);
    // 全程逐拍采样：既没有 offline，也没有 connectionRelayNoHost（「无失败闪态」靠的是它一直是 null）
    expect(samples.filter(s => s.status === 'offline')).toEqual([]);
    expect(samples.filter(s => s.connectionError === 'connectionRelayNoHost')).toEqual([]);
    unsubscribe();
  });

  it('② 15s 内电脑上线直接连上：无失败闪态；relayConstructed 与 3s 节拍吻合', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const samples: { status: string; connectionError: string | null }[] = [];
    const unsubscribe = store.subscribe(s => samples.push({ status: s.status, connectionError: s.connectionError }));
    await store.getState().hydrate();
    expect(harness.relayConstructed).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.relayConstructed).toBe(2);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(harness.relayConstructed).toBe(2); // 拍间不拨
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.relayConstructed).toBe(3);
    harness.relayError = null; // 电脑上线
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.relayConstructed).toBe(4);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', connectionError: null, relayNoHostWaiting: false });
    expect(samples.filter(s => s.status === 'offline')).toEqual([]);
    expect(samples.filter(s => s.connectionError === 'connectionRelayNoHost')).toEqual([]);
    unsubscribe();
    store.getState().pause();
  });

  it('③ 15s 到点落回现有失败页：offline + connectionRelayNoHost；认输后自动重连照旧、不再复活过渡态', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(store.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayNoHost', relayNoHostWaiting: false, transport: null });
    // connectionRelayNoHost 不挡自动重连（行为照旧）
    expect(store.getState().autoRetrying).toBe(true);
    harness.relayConstructed = 0;
    await vi.advanceTimersByTimeAsync(5_000); // 首档 2s±50% ⇒ 这里面必有一拍
    expect(harness.relayConstructed).toBeGreaterThanOrEqual(1);
    // 认输后的 no-host 照旧走失败映射，不复活过渡态（否则失败页永远回不来）
    expect(store.getState().relayNoHostWaiting).toBe(false);
    expect(store.getState().status).toBe('offline');
  });

  it('④ 过渡态点「重新连接」= 立即重拨一次 + 重置 15s 计时（不是放弃等待落失败页）', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(9_000); // t=9：第 3 拍重拨刚结束
    expect(harness.relayConstructed).toBe(4);
    expect(store.getState().relayNoHostWaiting).toBe(true);
    await store.getState().reconnect({ resetBackoff: true });
    expect(harness.relayConstructed).toBe(5); // 立即多一次拨号，不等下一个 3s 拍
    expect(store.getState().relayNoHostWaiting).toBe(true); // 没有点按放弃
    await vi.advanceTimersByTimeAsync(14_999); // t≈9+15s 之内：计时被重置，不落失败页
    expect(store.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true });
    await vi.advanceTimersByTimeAsync(2); // 重置后的 15s 到点
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayNoHost', relayNoHostWaiting: false });
  });

  it('等待期间 relay 收到 revoke：立即 rejected，过渡态与全部等待定时器当场清掉，不被 15s 到点覆盖', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState().relayNoHostWaiting).toBe(true);
    harness.onRevoked?.();
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected', relayNoHostWaiting: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getState()).toMatchObject({ status: 'rejected', connectionError: 'connectionRejected' });
  });

  it('退后台即停（#1935 纪律）：过渡态收场、3s 拍不再重拨；回前台既有 reconnect 接手重新给满 15s', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState().relayNoHostWaiting).toBe(true);
    store.getState().pause();
    expect(store.getState().relayNoHostWaiting).toBe(false);
    const before = harness.relayConstructed;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.relayConstructed).toBe(before); // 后台不空转重拨
    await store.getState().reconnect(); // 回前台的既有路径（lifecycle active 同款调用）
    expect(store.getState().relayNoHostWaiting).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(store.getState().relayNoHostWaiting).toBe(true); // 全新一轮 15s
  });

  it('在途重拨被手动重连抢占（claim 代号链）：迟到的 NO_HOST 按代号丢弃，不覆盖过渡态的新节拍', async () => {
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    await store.getState().hydrate();
    expect(store.getState().relayNoHostWaiting).toBe(true);
    harness.hangRelayOnce = true; // t=3 那拍自动重拨挂起在途
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.getState().busy).toBe(true);
    expect(store.getState().autoAttempt).toBe(true); // 自动尝试在途 ⇒ 手动点按可抢占（D3）
    const before = harness.relayConstructed;
    const manual = store.getState().reconnect({ resetBackoff: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.relayConstructed).toBe(before + 1); // 手动立即重拨
    harness.releaseRelay?.('COMPANION_RELAY_NO_HOST'); // 被抢占那拍的迟到结局
    await manual;
    await vi.advanceTimersByTimeAsync(0);
    // 迟到结果被代号丢弃：不落失败页、不打断手动重连后的过渡态
    expect(store.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true, connectionError: null, busy: false });
  });
});

/**
 * FB-197 并行竞速（fake timers 控时）：有缓存 relay 路由时 LAN 与 relay 同发起拨、
 * 先成者胜；LAN 后通收敛回直连；身份类失败取消在途 relay；双败抛 relay 码；抢占不双跑。
 */
describe('companionStore 竞速：LAN 与 relay 并行拨号、先成者胜', () => {
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  beforeEach(() => {
    harness.lanError = null; harness.relayError = null;
    harness.relayConstructed = 0; harness.relayClosed = 0;
    harness.relayRequests = []; harness.lanRequests = [];
    harness.lanGate = null; harness.relayGate = null;
    harness.relayCommandState = 'accepted';
    harness.hangSync = false; harness.rejectSync = null;
    harness.hangRelayCommandOnce = false; harness.releaseRelayCommand = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('① LAN 挂住 10s、relay 100ms 通 ⇒ 1s 内 connected/relay；LAN 后败停在 relay', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    // 竞速：relay 拨号已发起，不再等 LAN 失败。
    expect(harness.relayConstructed).toBe(1);
    await vi.advanceTimersByTimeAsync(100);            // relay 100ms 通
    relay.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    // work 到这里就返回（FB-197 ai-review Important）：LAN 段仍在拨，busy 已当场释放——
    // 发送/语音/审批/停止/sync 不再被锁到 LAN 段（地址数 × 10s）跑完。
    expect(store.getState().busy).toBe(false);
    await vi.advanceTimersByTimeAsync(900);            // 到 1s：LAN 仍挂着，状态已落 relay
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    await vi.advanceTimersByTimeAsync(9_000);          // LAN 单地址 10s 上限也过了
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    lan.release();                                      // LAN 后败：停在 relay
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);              // 推进后台收敛任务（停 relay 的结算）
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', busy: false });
    store.getState().pause();
  });

  it('② LAN 100ms 通、relay 慢 ⇒ connected/lan 且在途 relay 被关，从未成为通道', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.relayConstructed).toBe(1);
    await vi.advanceTimersByTimeAsync(100);            // LAN 100ms 通
    lan.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    // 输在途的 relay 拨号（从构造起记账）被 close；它没发过任何会话请求。
    expect(harness.relayClosed).toBeGreaterThanOrEqual(1);
    expect(harness.relayRequests).toEqual([]);
    // 迟到的 relay 拨号在已关的通道上失败：不落状态、不双跑。
    relay.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    await hydrating;
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', busy: false });
    store.getState().pause();
  });

  it('③ relay 先通、LAN 同次尝试后通 ⇒ busy 先释放、结算等 LAN 落定且只在 LAN 上跑一次', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE, pending: PENDING_COMMAND }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    relay.release();                                    // relay 先通
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    // busy 在 LAN 段落定前已释放（FB-197 ai-review Important）；断连遗留的待确认命令此刻
    // 还没结算——结算纪律：等 LAN 段落定，只在最终胜出的通道上跑（一次）。
    expect(store.getState().busy).toBe(false);
    expect(store.getState().pending).toBe(true);
    expect(harness.lanRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    lan.release();                                      // LAN 同次 attempt 内后通：收敛
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);               // 推进后台收敛/结算链
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', busy: false });
    // 结算纪律：待确认命令只在最终胜出的通道（LAN）上结算一次，relay 上没结算过。
    expect(harness.lanRequests.filter(payload => payload.action === 'status')).toHaveLength(1);
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    expect(store.getState().pending).toBe(false);
    // 收敛 = relay 通道被关掉，同一时刻只有一条活通道。
    expect(harness.relayClosed).toBeGreaterThanOrEqual(1);
    store.getState().pause();
  });

  it('④ relay 先败 NO_HOST、LAN 后败 ⇒ 双败进「等电脑上线」过渡态不落失败页，15s 到点才认输（#1942 并入竞速）', async () => {
    harness.relayError = 'COMPANION_RELAY_NO_HOST';    // relay 即败（无闸）
    const lan = gate();
    harness.lanGate = lan.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().status).not.toBe('connected');   // LAN 未出结论前不提前落状态
    expect(store.getState().relayNoHostWaiting).toBe(false); // relay 的 NO_HOST 单独不触发：等 LAN
    harness.lanError = 'COMPANION_CONNECTION_REFUSED';
    lan.release();                                      // LAN 后败：双败 ⇒ no-host 过渡态
    await hydrating;
    expect(store.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true, connectionError: null, busy: false });
    // 过渡态的 3s 重拍都是双败 no-host：不复活失败页
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true, connectionError: null });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.getState()).toMatchObject({ status: 'connecting', relayNoHostWaiting: true });
    await vi.advanceTimersByTimeAsync(1);              // 15s 到点：认输，落回现有失败页
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRelayNoHost', relayNoHostWaiting: false, transport: null });
  });

  it('⑥ relay 先败 NO_HOST、LAN 后通 ⇒ 直接 connected/lan，不进过渡态（已连上不等电脑）', async () => {
    harness.relayError = 'COMPANION_RELAY_NO_HOST';    // relay 即败（无闸）
    const lan = gate();
    harness.lanGate = lan.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().relayNoHostWaiting).toBe(false); // LAN 在途：双败未成立，不进过渡态
    lan.release();                                      // LAN 后通：relay 的 NO_HOST 不触发等待
    await hydrating;
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', relayNoHostWaiting: false, connectionError: null });
    await vi.advanceTimersByTimeAsync(20_000);          // 也不会晚进：已经连上
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', relayNoHostWaiting: false });
    store.getState().pause();
  });

  it('LAN 出身份类错误 ⇒ 取消在途 relay 拨号直接抛，不落 relay（换路不换身份）', async () => {
    harness.lanError = 'COMPANION_HOST_KEY_MISMATCH';  // LAN 即败（无闸）
    const relay = gate();
    harness.relayGate = relay.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.relayConstructed).toBe(1);
    await hydrating;
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRejected', autoRetrying: false });
    // 在途 relay 拨号被取消（close 过）、从未成为通道、没发过任何请求。
    expect(harness.relayClosed).toBeGreaterThanOrEqual(1);
    expect(harness.relayRequests).toEqual([]);
    // 迟到的 relay connect 在已关的通道上失败，不再改变状态。
    relay.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRejected' });
  });

  it('⑤ 竞速途中被手动重连抢占 ⇒ 两条通道都关掉、不双跑、不落状态', async () => {
    const lan1 = gate();
    const relay1 = gate();
    harness.lanGate = lan1.promise;
    harness.relayGate = relay1.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();      // 自动尝试 #1：两条都挂在途
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ busy: true, autoAttempt: true });
    expect(harness.relayConstructed).toBe(1);
    const firstLanIndex = harness.lanClients.length - 1;
    // 手动重连抢占：#2 起跑（两条闸都不挂，立即出结论），#1 的 LAN 客户端被 createClient 关掉、
    // #1 的 relay 拨号被 #2 的 dialRelay 关掉。
    harness.lanGate = null;
    harness.relayGate = null;
    const manual = store.getState().reconnect({ resetBackoff: true });
    await manual;
    expect(harness.lanClients[firstLanIndex].alive).toBe(false);   // #1 的 LAN 被关
    expect(store.getState()).toMatchObject({ status: 'connected', busy: false });
    // #1 的 relay 迟到结算（已关 ⇒ 失败）与 LAN 迟到结算（已关 ⇒ 失败）都被代号丢弃。
    relay1.release();
    lan1.release();
    await vi.advanceTimersByTimeAsync(0);
    await hydrating;
    // 最终状态只由 #2 落；#1 的 relay 从未发过请求（不双跑）。
    expect(store.getState()).toMatchObject({ status: 'connected', busy: false });
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    store.getState().pause();
  });

  it('⑦ 账号路由在途被竞速赢方关掉 ⇒ 票据不作废、不回落旧路由再拨（败局归结算方）', async () => {
    // 配对盘：账号路由 + 票据 + 旧路由都在（#1938 双路由形态）。有票据先拨账号路由。
    const store = storeWith(storageWith({
      relay: RELAY_ROUTE,
      relayAccount: { v: 1, url: 'ws://127.0.0.1:8792/', routeToken: 'account-route-token' },
      account: { ticket: 'neo1.device-ticket', email: 'user@example.com', userId: 'user-1' },
    }));
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.relayConstructed).toBe(1);          // 账号路由先拨（唯一一笔在途）
    lan.release();                                      // LAN 先通：关掉在途的账号路由拨号
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    relay.release();                                    // 被关的拨号迟到失败（close 分类 AUTH_REJECTED）
    await vi.advanceTimersByTimeAsync(0);
    await hydrating;
    // close 是结算方主动收的，不是 relay 拒了凭据：票据不作废（登录态在、不翻 S8）、
    // wrapper 不当次回落旧路由再拨（没有第二笔构造/活通道）。
    expect(harness.relayConstructed).toBe(1);
    expect(harness.relayClosed).toBe(1);
    expect(store.getState().account).toMatchObject({ email: 'user@example.com' });
    expect(store.getState().loginPrompt).toBe(false);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', busy: false });
    store.getState().pause();
  });

  it('⑧ relay 先通、LAN 后败 ⇒ busy 先释放，遗留命令停在 relay 上结算（恰一次，LAN 上零次）', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE, pending: PENDING_COMMAND }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    relay.release();                                    // relay 先通
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(store.getState().busy).toBe(false);          // LAN 段仍在拨，busy 已释放
    expect(store.getState().pending).toBe(true);        // 遗留命令还没结算：等 LAN 落定
    harness.lanError = 'COMPANION_NETWORK_UNAVAILABLE';
    lan.release();                                      // LAN 后败：停在 relay
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);               // 推进后台结算
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', busy: false });
    // 结算纪律：LAN 没赢，最终胜出的通道是 relay——status 查询只在 relay 上出现一次。
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(1);
    expect(harness.lanRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    expect(store.getState().pending).toBe(false);
    expect(harness.relayClosed).toBe(0);                // relay 是会话通道，没被关
    store.getState().pause();
  });

  it('⑨ relay 先通后用户在 relay 上发命令、LAN 后通 ⇒ 不收敛（保守解）：停在 relay 结算，LAN 通道只被关掉', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const lanStart = harness.lanClients.length;        // 本用例的竞速 LAN 客户端从这起（数组跨用例共享）
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    relay.release();                                    // relay 先通
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', busy: false });
    // busy 已释放 ⇒ 用户当场能发命令。命令进 reconciling（电脑还在处理）：槽驻留在 relay 侧。
    harness.relayCommandState = 'reconciling';
    await store.getState().send('九-在途命令');
    expect(store.getState().pending).toBe(true);
    expect(store.getState().busy).toBe(false);
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    lan.release();                                      // LAN 同次 attempt 内后通
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);               // 推进后台收敛任务
    // 保守解：在途命令挂在 relay 上，不收敛——会话停在 relay，LAN 客户端只被关掉防双跑。
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', busy: false });
    expect(harness.lanClients[lanStart].alive).toBe(false);
    expect(harness.relayClosed).toBe(0);
    // 结算恰一次，且在 relay 上（reconciling 驻留：槽保留，等电脑出结论）。
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(1);
    expect(harness.lanRequests.filter(payload => payload.action === 'status')).toHaveLength(0);
    expect(store.getState().pending).toBe(true);
    store.getState().pause();
  });

  it('⑩ relay 先败 NO_HOST、LAN 后败身份类 ⇒ 抛 LAN 的码落 connectionRejected，不挂自动重试（双败按身份类优先选码）', async () => {
    harness.relayError = 'COMPANION_RELAY_NO_HOST';    // relay 即败（无闸）：缓存路由恰好失效
    const lan = gate();
    harness.lanGate = lan.promise;
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().relayNoHostWaiting).toBe(false); // LAN 在途：双败未成立
    harness.lanError = 'COMPANION_BINDING_CHANGED';   // LAN 后败：电脑改了共享范围/重新配对
    lan.release();
    await hydrating;
    // 身份类优先：落 connectionRejected（connectionBlocksAutoRetry 生效），不落 connectionRelay*
    // ——否则手机按退避无限重连，用户永远看不到「需要重新扫码」这条唯一出路。
    expect(store.getState()).toMatchObject({ status: 'offline', connectionError: 'connectionRejected', relayNoHostWaiting: false, transport: null, busy: false });
    expect(store.getState().autoRetrying).toBe(false);
  });

  it('⑪ relay 赢后 sync 在飞时收敛到 LAN ⇒ sync 不误关 LAN 客户端、状态不闪 offline（通道身份核验）', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    harness.hangSync = true;                           // relay 面的 sync 挂起在飞
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const lanStart = harness.lanClients.length;        // 本用例竞速 LAN 客户端从这起（数组跨用例共享）
    const samples: { status: string }[] = [];
    const unsubscribe = store.subscribe(s => samples.push({ status: s.status }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    relay.release();                                   // relay 先通：立刻 connected/relay
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', busy: false });
    const syncing = store.getState().sync();           // 这条 sync 挂在 relay 上在飞
    await vi.advanceTimersByTimeAsync(0);
    if (!harness.rejectSync) throw new Error('sync 未挂起：rejectSync 缺失');
    lan.release();                                     // LAN 约 10s 后通：后台收敛换手 client=lan
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);              // 推进收敛链（settleLanSession/路由刷新）
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan' });
    // 收敛关 relay 触发在飞 sync 的 rejection：这份失败不结算到新通道头上——LAN 客户端活着、
    // 不闪 offline、不挂自动重试。
    harness.rejectSync?.(new Error('COMPANION_NOT_CONNECTED'));
    await syncing;
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.lanClients[lanStart].alive).toBe(true);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'lan', autoRetrying: false });
    expect(samples.filter(s => s.status === 'offline')).toEqual([]);
    unsubscribe();
    store.getState().pause();
    harness.hangSync = false; harness.rejectSync = null;
  });

  it('⑫ busy 占用时收敛让位结算 ⇒ busy 落地补一次重排，遗留命令不等 UI 的 sync 轮询收口', async () => {
    const lan = gate();
    const relay = gate();
    harness.lanGate = lan.promise;
    harness.relayGate = relay.promise;
    harness.hangRelayCommandOnce = true;               // 用户的在飞命令挂在 relay 上（占住 busy）
    const store = storeWith(storageWith({ relay: RELAY_ROUTE }));
    const hydrating = store.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    relay.release();                                   // relay 先通
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay', busy: false });
    const sending = store.getState().send('十二-在途命令');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().busy).toBe(true);          // send 的 deliver 在飞：busy 被占
    lan.release();                                     // LAN 后通：用户命令在途 ⇒ 停 relay，结算让位
    await hydrating;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ status: 'connected', transport: 'relay' });
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(0); // busy 让位：没抢结算
    harness.releaseRelayCommand?.('reconciling');      // 命令回 reconciling：槽驻留，busy 释放
    await sending;
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().busy).toBe(false);
    // busy 落地 ⇒ 补一次重排：status 查询恰一次（此前只能等 UI 的 sync 轮询），补投把槽收口。
    expect(harness.relayRequests.filter(payload => payload.action === 'status')).toHaveLength(1);
    expect(store.getState().pending).toBe(false);
    store.getState().pause();
  });
});
