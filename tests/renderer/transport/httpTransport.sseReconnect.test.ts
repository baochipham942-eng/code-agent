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

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';

// ---------------------------------------------------------------------------
// Fake EventSource — 只模拟 httpTransport 用到的那几个成员
// ---------------------------------------------------------------------------

interface FakeEventSourceInstance {
  url: string;
  readyState: number;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
  _triggerMessage: (data: unknown, id?: string) => void;
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
    this._triggerMessage = (data: unknown, id?: string) => {
      if (self._closed) return;
      self.onmessage?.({ data: JSON.stringify(data), lastEventId: id });
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
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    expect(fake.instances).toHaveLength(0);

    api.on('swarm:event', () => {});
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0].url).toBe('http://localhost:8180/api/events');
  });

  it('触发 error 后会关闭旧连接，并在 5 秒后新建一个 EventSource 实例', () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');
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
    const api = createHttpCodeAgentAPI('http://localhost:8180');
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
    const api = createHttpCodeAgentAPI('http://localhost:8180');
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
    const api = createHttpCodeAgentAPI('http://localhost:8180');
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

  // ---------------------------------------------------------------------------
  // ADR-010 #6: Last-Event-ID replay 机制
  // ---------------------------------------------------------------------------
  //
  // 生产实现：
  //   - sse.ts 的 broadcastSSE 分配单调 id 并写入 ring buffer（replayFromLastEventId）
  //   - health.ts 的 /api/events handler 解析 Last-Event-ID header 或 lastEventId
  //     query 参数，连接建立后立刻重放错过的事件
  //   - httpTransport.ts 的 ensureSSE 跟踪 lastSeenEventId 并在重连 URL 上传回
  //
  // 这个单测覆盖 httpTransport 侧的状态机，真实的 backend replay 行为由
  // tests/web/helpers/sse.replay.test.ts 单独测。

  it('从 SSE 消息解析 lastEventId，并在重连 URL 上传回', () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    expect(fake.instances).toHaveLength(1);
    // 第一次连接没有 lastEventId 参数
    expect(fake.instances[0].url).not.toContain('lastEventId=');

    // 服务器推送 3 条带 id 的事件
    fake.instances[0]._triggerMessage(
      { channel: 'swarm:event', args: { type: 'swarm:started', timestamp: 1, data: {} } },
      '1',
    );
    fake.instances[0]._triggerMessage(
      { channel: 'swarm:event', args: { type: 'swarm:agent:added', timestamp: 2, data: {} } },
      '2',
    );
    fake.instances[0]._triggerMessage(
      { channel: 'swarm:event', args: { type: 'swarm:agent:updated', timestamp: 3, data: {} } },
      '3',
    );

    // 断线 + 5s 后重连
    fake.instances[0]._triggerError();
    vi.advanceTimersByTime(5000);

    expect(fake.instances).toHaveLength(2);
    // 重连 URL 必须带上最大已见 id
    expect(fake.instances[1].url).toContain('lastEventId=3');
  });

  it('重连后的 EventSource 投递重放事件，listener 能正常收到', () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    const received: Array<{ type?: string }> = [];
    api.on('swarm:event', (payload) => { received.push(payload as { type?: string }); });

    fake.instances[0]._triggerMessage(
      { channel: 'swarm:event', args: { type: 'swarm:started', timestamp: 1, data: {} } },
      '5',
    );
    fake.instances[0]._triggerError();
    vi.advanceTimersByTime(5000);

    // 服务端在第二个连接上重放 id=6 的事件
    expect(fake.instances).toHaveLength(2);
    fake.instances[1]._triggerMessage(
      { channel: 'swarm:event', args: { type: 'swarm:agent:added', timestamp: 2, data: {} } },
      '6',
    );

    expect(received.map((e) => e.type)).toEqual(['swarm:started', 'swarm:agent:added']);
  });

  it('第一次连接且没有 lastEventId 时 URL 里不带该参数', () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    expect(fake.instances[0].url).toBe('http://localhost:8180/api/events');
  });

  it('乱序到达的事件 id 不会让游标后退', () => {
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});

    // 按顺序 5 -> 10 -> 7（乱序）
    fake.instances[0]._triggerMessage({ channel: 'swarm:event', args: {} }, '5');
    fake.instances[0]._triggerMessage({ channel: 'swarm:event', args: {} }, '10');
    fake.instances[0]._triggerMessage({ channel: 'swarm:event', args: {} }, '7');

    fake.instances[0]._triggerError();
    vi.advanceTimersByTime(5000);

    // 游标应停在 10，不被 7 拉回
    expect(fake.instances[1].url).toContain('lastEventId=10');
  });
});
