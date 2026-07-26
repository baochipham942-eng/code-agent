// VoiceTransport 契约双跑（方案 §9.2 / §13.3 第 1 条）：
// relay 形态必须实现 sendAudio（媒体经 Host 中继），direct 形态必须给出
// clientBootstrap（Renderer 直连上游）。判别联合把「永远不该被调用的 no-op」
// 从接口上消灭，本测试钉住两侧真跑出来的 handle 形态——真 OpenAI adapter 未落地，
// direct 侧用 fake adapter 钉形态。
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { VoiceEvent, VoiceTransport, VoiceTransportHandle, VoiceTurnDetectionConfig } from '../../src/shared/contract/voice';

/** 最小 ws 替身：qwenOmniTransport 只用到 open/error 事件、send、readyState、close。 */
class FakeUpstream extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
}

const upstreams: FakeUpstream[] = [];
const mockConfig = vi.hoisted(() => ({
  settings: {} as { voice?: { turnDetection?: VoiceTurnDetectionConfig } },
}));

vi.mock('ws', () => {
  class MockWebSocket extends FakeUpstream {
    static OPEN = 1;
    constructor() {
      super();
      upstreams.push(this);
      setTimeout(() => this.emit('open'), 0);
    }
  }
  return { default: MockWebSocket };
});
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => mockConfig.settings }),
}));

const { qwenOmniTransport } = await import('../../src/host/services/voice/qwenOmniTransport');

/**
 * direct 形态占位 adapter：真 OpenAI Realtime adapter 单独排批，这里只钉抽象
 * 必须容得下「不经 Host 的媒体面」——它没有 sendAudio，且必须给出建连材料。
 */
const fakeDirectTransport: VoiceTransport = {
  id: 'openai-realtime',
  async connect() {
    return {
      kind: 'direct',
      provider: 'openai-realtime',
      clientBootstrap: { kind: 'webrtc', clientSecret: 'ephemeral-x', sdpUrl: 'https://example.invalid/sdp', expiresAt: 1 },
      interrupt: vi.fn(),
      close: async () => undefined,
    };
  },
};

async function connectHandle(transport: VoiceTransport): Promise<VoiceTransportHandle> {
  return transport.connect({
    apiKey: 'test-key',
    config: { neoSessionId: 's1' },
    onEvent: vi.fn(),
    onAudio: vi.fn(),
  });
}

function readSessionUpdate(upstream: FakeUpstream): { session: { turn_detection?: unknown } } {
  const raw = upstream.sent.find((item) => (JSON.parse(item) as { type?: string }).type === 'session.update');
  if (!raw) throw new Error('missing session.update');
  return JSON.parse(raw) as { session: { turn_detection?: unknown } };
}

describe('VoiceTransport 契约（relay / direct 双跑）', () => {
  beforeEach(() => {
    upstreams.length = 0;
    mockConfig.settings = {};
  });

  it('relay adapter：kind=relay 且 sendAudio 真把帧推给上游', async () => {
    const handle = await connectHandle(qwenOmniTransport);

    expect(handle.kind).toBe('relay');
    if (handle.kind !== 'relay') throw new Error('unreachable');

    const upstream = upstreams[upstreams.length - 1];
    const before = upstream.sent.length;
    handle.sendAudio(Buffer.from([1, 2, 3, 4]));
    const appended = upstream.sent.slice(before).map((raw) => JSON.parse(raw) as { type: string; audio?: string });
    expect(appended.map((e) => e.type)).toContain('input_audio_buffer.append');
    expect(appended[0].audio).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));

    await handle.close();
  });

  it('默认 turn_detection 发 server_vad，且三项参数映射为上游 snake_case', async () => {
    const handle = await connectHandle(qwenOmniTransport);
    const upstream = upstreams[upstreams.length - 1];
    const update = readSessionUpdate(upstream);

    expect(update.session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
    });

    await handle.close();
  });

  it('配置 semantic_vad 时按配置发给上游', async () => {
    mockConfig.settings = { voice: { turnDetection: { type: 'semantic_vad', eagerness: 'high' } } };

    const handle = await connectHandle(qwenOmniTransport);
    const upstream = upstreams[upstreams.length - 1];
    const update = readSessionUpdate(upstream);

    expect(update.session.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'high' });

    await handle.close();
  });

  it('response.done 同时报 ttfaModelMs 和按 server_vad 静音窗推算的 ttfaPerceivedMs', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[upstreams.length - 1];
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(10_000);
    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    nowSpy.mockReturnValue(10_427);
    upstream.emit('message', JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([1]).toString('base64') }));
    upstream.emit('message', JSON.stringify({ type: 'response.done' }));

    const done = events.find((event) => event.type === 'response.done');
    expect(done).toMatchObject({ type: 'response.done', ttfaModelMs: 427, ttfaPerceivedMs: 927 });

    nowSpy.mockRestore();
    await handle.close();
  });

  it('turn_detection 关闭时 response.done 不报 ttfaPerceivedMs', async () => {
    mockConfig.settings = { voice: { turnDetection: null } };
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[upstreams.length - 1];
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(20_000);
    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    nowSpy.mockReturnValue(20_300);
    upstream.emit('message', JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([2]).toString('base64') }));
    upstream.emit('message', JSON.stringify({ type: 'response.done' }));

    const done = events.find((event) => event.type === 'response.done');
    expect(done).toMatchObject({ type: 'response.done', ttfaModelMs: 300 });
    expect(done && 'ttfaPerceivedMs' in done).toBe(false);

    nowSpy.mockRestore();
    await handle.close();
  });

  it('注册了窄工具时才发 tools；没接执行出口就一个都不发', async () => {
    const withoutTools = await connectHandle(qwenOmniTransport);
    const bare = readSessionUpdate(upstreams[upstreams.length - 1]).session as { tools?: unknown };
    expect(bare.tools).toBeUndefined();
    await withoutTools.close();

    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [{ type: 'function', name: 'get_active_tasks', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }] },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
      onToolCall: async () => 'ok',
    });
    const withTools = readSessionUpdate(upstreams[upstreams.length - 1]).session as { tools?: Array<{ name: string }> };
    expect(withTools.tools?.map((t) => t.name)).toEqual(['get_active_tasks']);
    await handle.close();
  });

  // 上游 function_call 必须被执行并把结果回灌，再显式要一次回复——
  // 只写回结果不发 response.create 的话，模型拿到了结果也不开口，现场表现是「通话卡住」。
  it('function_call 交给执行出口，结果回灌后再要一次回复', async () => {
    const onToolCall = vi.fn(async () => '当前没有进行中的任务。');
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [{ type: 'function', name: 'get_active_tasks', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }] },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
      onToolCall,
    });
    const upstream = upstreams[upstreams.length - 1];
    const before = upstream.sent.length;

    upstream.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'get_active_tasks',
      arguments: '{}',
    }));

    await vi.waitFor(() => expect(upstream.sent.length).toBeGreaterThan(before + 1));
    expect(onToolCall).toHaveBeenCalledWith({ callId: 'call_1', name: 'get_active_tasks', arguments: '{}' });
    const emitted = upstream.sent.slice(before).map((raw) => JSON.parse(raw) as { type: string; item?: { call_id?: string; output?: string } });
    expect(emitted[0].item).toMatchObject({ call_id: 'call_1', output: '当前没有进行中的任务。' });
    expect(emitted[1].type).toBe('response.create');

    await handle.close();
  });

  it('direct adapter：kind=direct 且必须给出 clientBootstrap', async () => {
    const handle = await connectHandle(fakeDirectTransport);

    expect(handle.kind).toBe('direct');
    if (handle.kind !== 'direct') throw new Error('unreachable');
    expect(handle.clientBootstrap.clientSecret).toBeTruthy();
    expect(handle.clientBootstrap.sdpUrl).toBeTruthy();

    // 判别联合的价值：direct 上根本没有 sendAudio 可调，而不是调了个 no-op。
    expect('sendAudio' in handle).toBe(false);

    await handle.close();
  });
});
