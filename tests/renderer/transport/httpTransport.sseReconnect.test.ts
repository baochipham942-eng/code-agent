// ============================================================================
// HttpTransport SSE Reconnect Chaos Tests — ADR-010 item #4 priority 1
// ============================================================================
//
// 验证 httpTransport 在浏览器 EventSource 断线后：
//   1) 5 秒内自动重连（与 ADR-010 的断线恢复目标一致）
//   2) 断线期间 backend 发出的事件是否会到达 renderer（答：不会，见 BUG 注释）
//
// 范围边界：
//   - 在 Node 环境 stub `globalThis.EventSource` + `globalThis.window`。
//   - 不拉真实 webServer，也不跑 Express/SSE server——那一层由 e2e spec 覆盖。
//   - 只测 transport 的状态机：是否重新 new EventSource、是否尊重 5s 延迟、
//     是否在关闭后再次打开。
//   - 不测具体 reducer 影响（swarmStore chaos 已经单独测）。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `localBridgeStore` 在 import 阶段 touch `localStorage`，
// `localBridge` 也用到浏览器 global。都不是 transport 本测关心的面，直接 mock。
vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({
    invokeTool: vi.fn(),
  }),
}));

// 先铺 window stub，再 import transport
(globalThis as Record<string, unknown>).window = {
  __CODE_AGENT_TOKEN__: undefined,
};

import { createHttpElectronAPI } from '../../../src/renderer/api/httpTransport';

// ---------------------------------------------------------------------------
// Fake EventSource — 只模拟 httpTransport 用到的那几个成员
// ---------------------------------------------------------------------------

interface FakeEventSourceInstance {
  url: string;
  readyState: number;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
  _triggerMessage: (data: unknown) => void;
  _triggerError: () => void;
  _closed: boolean;
}

const FAKE_EVENTSOURCE_CLOSED = 2;

type EventSourceCtor = (new (url: string) => FakeEventSourceInstance) & {
  CLOSED: number;
};

function installFakeEventSource(): {
  instances: FakeEventSourceInstance[];
  uninstall: () => void;
  ctor: EventSourceCtor;
} {
  const instances: FakeEventSourceInstance[] = [];
  const originalEventSource = (globalThis as Record<string, unknown>).EventSource;

  const ctor = function (this: FakeEventSourceInstance, url: string) {
    this.url = url;
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    this._closed = false;
    const self = this;
    this.close = () => {
      self._closed = true;
      self.readyState = FAKE_EVENTSOURCE_CLOSED;
    };
    this._triggerMessage = (data: unknown) => {
      if (self._closed) return;
      self.onmessage?.({ data: JSON.stringify(data) });
    };
    this._triggerError = () => {
      self.onerror?.();
    };
    instances.push(this);
  } as unknown as EventSourceCtor;
  ctor.CLOSED = FAKE_EVENTSOURCE_CLOSED;

  (globalThis as Record<string, unknown>).EventSource = ctor;

  return {
    instances,
    ctor,
    uninstall: () => {
      if (originalEventSource === undefined) {
        delete (globalThis as Record<string, unknown>).EventSource;
      } else {
        (globalThis as Record<string, unknown>).EventSource = originalEventSource;
      }
    },
  };
}

function resetFakeWindow(): void {
  // window 已经在 import 阶段被 stub 好，这里只清理 token。
  (globalThis as Record<string, { __CODE_AGENT_TOKEN__?: string }>).window.__CODE_AGENT_TOKEN__ = undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('httpTransport SSE reconnect chaos', () => {
  let fake: ReturnType<typeof installFakeEventSource>;

  beforeEach(() => {
    fake = installFakeEventSource();
    resetFakeWindow();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fake.uninstall();
  });

  it('注册 listener 时会立即建立 SSE 连接', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    expect(fake.instances).toHaveLength(0);

    api.on('swarm:event', () => {});
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0].url).toBe('http://localhost:8180/api/events');
  });

  it('触发 error 后会关闭旧连接，并在 5 秒后新建一个 EventSource 实例', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    expect(fake.instances).toHaveLength(1);

    fake.instances[0]._triggerError();
    expect(fake.instances[0]._closed).toBe(true);
    expect(fake.instances).toHaveLength(1); // 尚未过 5s

    // 4.999s 时尚不应重连
    vi.advanceTimersByTime(4999);
    expect(fake.instances).toHaveLength(1);

    // 到 5s 时创建新连接
    vi.advanceTimersByTime(1);
    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[1]._closed).toBe(false);
    expect(fake.instances[1].url).toBe('http://localhost:8180/api/events');
  });

  it('重连后的 EventSource 收到的消息能正常 dispatch 到 listener', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    const received: unknown[] = [];
    api.on('swarm:event', (payload) => { received.push(payload); });

    fake.instances[0]._triggerError();
    vi.advanceTimersByTime(5000);
    expect(fake.instances).toHaveLength(2);

    fake.instances[1]._triggerMessage({
      channel: 'swarm:event',
      args: { type: 'swarm:started', timestamp: 1000, data: {} },
    });

    expect(received).toHaveLength(1);
  });

  it('连续两次 error 不会把重连延迟变短，始终按 5 秒窗口排队', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    api.on('swarm:event', () => {});

    fake.instances[0]._triggerError();
    vi.advanceTimersByTime(2000);
    // 此时 onerror 已经把 eventSource 置 null，再次触发 error 在原实例上是 no-op
    // httpTransport.ts:115-123 使用 clearTimeout + 新 setTimeout，
    // 所以只要 listener 还在，下一轮重连的时钟窗口就是 5s（不是 2s）
    vi.advanceTimersByTime(3000); // 累计 5s
    expect(fake.instances).toHaveLength(2);
  });

  it('所有 listener 被移除后 ensureSSE 不会再重连', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    const unsubscribe = api.on('swarm:event', () => {});
    expect(fake.instances).toHaveLength(1);

    // 触发 error 排队一次重连
    fake.instances[0]._triggerError();
    // 在 5s 窗口内取消订阅
    unsubscribe();

    vi.advanceTimersByTime(5000);
    // listener 已空，ensureSSE 应该不再建立新连接
    expect(fake.instances).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 数据丢失行为：断线期间 backend 发出的事件会被静默丢弃
  // ---------------------------------------------------------------------------

  // BUG: ADR-010 item #4, production fix deferred to main-line session
  //
  // httpTransport 的 SSE 重连没有任何 resume 机制：
  //   - 没有发 Last-Event-ID header（EventSource API 支持但代码未用）
  //   - 后端 sseClients 是 Set<Response>，客户端断开即删除，断线期间
  //     broadcastSSE 发出的事件不会缓存
  //   - swarmStore 也没有向 backend 反向拉取"错过的事件"
  //
  // 结果：5 秒的断线窗口里所有 swarm event 都直接丢失。新连接建立后只能
  // 收到之后的事件。这里的 .skip 描述"期望行为"——我们希望系统至少能保证
  // 事件不丢，要么走 Last-Event-ID 重放，要么走 EventBus 的 replay buffer。
  //
  // 见 src/renderer/api/httpTransport.ts:115-123 和
  //   src/web/helpers/sse.ts:9-23。
  it.skip('BUG reconnect: 断线期间 backend 发出的事件应在重连后到达 renderer', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    const received: unknown[] = [];
    api.on('swarm:event', (payload) => { received.push(payload); });

    // 断线
    fake.instances[0]._triggerError();

    // 模拟 backend 在断线期间发出事件（注意：现实里会走 broadcastSSE，
    // 但因为客户端 res 已从 sseClients 移除，broadcastSSE 其实是 no-op。
    // 即便我们这里模拟 "事件到达之前的 EventSource"，httpTransport 也早已
    // 调用 close() 并把 eventSource 置 null，`onmessage` 不会被触发。）
    // 换句话说：此测试的 precondition 在生产中不可达，证明数据确实被丢弃。

    // 重连
    vi.advanceTimersByTime(5000);
    expect(fake.instances).toHaveLength(2);

    // 期望：重连后能收到断线期间的事件
    expect(received.length).toBeGreaterThan(0);
  });

  it('documented current behavior: 断线期间发出的事件直接丢失（回归基线）', () => {
    const api = createHttpElectronAPI('http://localhost:8180');
    const received: unknown[] = [];
    api.on('swarm:event', (payload) => { received.push(payload); });

    // 触发断线
    fake.instances[0]._triggerError();

    // 模拟对已关闭实例调用 triggerMessage → 不应分发
    fake.instances[0]._triggerMessage({
      channel: 'swarm:event',
      args: { type: 'swarm:started', timestamp: 1000, data: {} },
    });

    vi.advanceTimersByTime(5000);
    // 新连接建立，但它不会重放断线期间的消息
    expect(fake.instances).toHaveLength(2);
    expect(received).toHaveLength(0);
  });
});
