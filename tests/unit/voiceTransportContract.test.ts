// VoiceTransport 契约双跑（方案 §9.2 / §13.3 第 1 条）：
// relay 形态必须实现 sendAudio（媒体经 Host 中继），direct 形态必须给出
// clientBootstrap（Renderer 直连上游）。判别联合把「永远不该被调用的 no-op」
// 从接口上消灭，本测试钉住两侧真跑出来的 handle 形态——真 OpenAI adapter 未落地，
// direct 侧用 fake adapter 钉形态。
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { VoiceEvent, VoiceTransport, VoiceTransportHandle, VoiceTurnDetectionConfig } from '../../src/shared/contract/voice';
import { QWEN_OMNI_REALTIME_MODEL } from '../../src/shared/constants/voice';

/** 最小 ws 替身：qwenOmniTransport 只用到 open/error 事件、send、readyState、close。 */
class FakeUpstream extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  url = '';
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
  settings: {} as { voice?: { turnDetection?: VoiceTurnDetectionConfig; live?: { interrupt?: 'server_vad' | 'manual' } } },
}));

vi.mock('ws', () => {
  class MockWebSocket extends FakeUpstream {
    static OPEN = 1;
    constructor(url: string) {
      super();
      this.url = url;
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
      // 批 H 新增：instructions 增量刷新是两侧都必须实现的能力（焦点变化 / 切专家）。
      // direct 形态的媒体面不经 Host，但控制面照样要能刷——这条属于 Base，不属于分支。
      updateInstructions: vi.fn(),
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

  it('relay adapter：commit 发 input_audio_buffer.commit + response.create（PTT 手动提交）', async () => {
    const handle = await connectHandle(qwenOmniTransport);
    if (handle.kind !== 'relay') throw new Error('unreachable');

    const upstream = upstreams[upstreams.length - 1];
    const before = upstream.sent.length;
    handle.commit();
    const sent = upstream.sent.slice(before).map((raw) => JSON.parse(raw) as { type: string });
    expect(sent.map((e) => e.type)).toEqual(['input_audio_buffer.commit', 'response.create']);

    await handle.close();
  });

  it('默认 turn_detection 发 server_vad，且三项参数映射为上游 snake_case', async () => {
    const handle = await connectHandle(qwenOmniTransport);
    const upstream = upstreams[upstreams.length - 1];
    const update = readSessionUpdate(upstream);

    // 批 X2：silence 800 / prefix 500（阶梯停顿 A/B 实测，500 档真人犹豫必切碎）
    expect(update.session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 500,
      silence_duration_ms: 800,
    });

    await handle.close();
  });

  it('存量配置里的旧默认 prefix/silence（300/500）读取时升级为新默认，手改值保留', async () => {
    // prefix/silence 从来不是 UI 可设项，落盘 300/500 只可能是旧默认拷贝——
    // 「改默认值对存量用户零生效」是踩过的坑，读取口必须升级（批 X2）。
    mockConfig.settings = { voice: { turnDetection: { type: 'server_vad', threshold: 0.7, prefixPaddingMs: 300, silenceDurationMs: 500 } } };
    let handle = await connectHandle(qwenOmniTransport);
    expect(readSessionUpdate(upstreams[upstreams.length - 1]).session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.7, // 手选灵敏度保留
      prefix_padding_ms: 500,
      silence_duration_ms: 800,
    });
    await handle.close();

    // 手改过的实验值（非旧默认）原样保留，别把调参路堵死
    mockConfig.settings = { voice: { turnDetection: { type: 'server_vad', threshold: 0.5, prefixPaddingMs: 450, silenceDurationMs: 600 } } };
    handle = await connectHandle(qwenOmniTransport);
    expect(readSessionUpdate(upstreams[upstreams.length - 1]).session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 450,
      silence_duration_ms: 600,
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
    // perceived = model + silence 窗（批 X2 起默认 800）
    expect(done).toMatchObject({ type: 'response.done', ttfaModelMs: 427, ttfaPerceivedMs: 1227 });

    nowSpy.mockRestore();
    await handle.close();
  });

  it('relay handle 精确反映 response.created 到 response.done 的模型响应窗', async () => {
    const handle = await connectHandle(qwenOmniTransport);
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    expect(handle.isResponding()).toBe(false);
    upstream.emit('message', JSON.stringify({ type: 'response.created' }));
    expect(handle.isResponding()).toBe(true);
    upstream.emit('message', JSON.stringify({ type: 'response.done' }));
    expect(handle.isResponding()).toBe(false);

    await handle.close();
  });

  it('只把 injectItem 后未获响应确认的协议 error 分类为注入拒绝', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    handle.injectItem('播报任务失败');
    upstream.emit('message', JSON.stringify({
      type: 'error',
      error: { message: 'Conversation already has an active response' },
    }));
    expect(events.at(-1)).toEqual({
      type: 'injection.rejected',
      message: 'Conversation already has an active response',
    });

    handle.injectItem('再播一次');
    upstream.emit('message', JSON.stringify({ type: 'response.created' }));
    upstream.emit('message', JSON.stringify({ type: 'error', error: { message: 'connection failed' } }));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'UPSTREAM_ERROR',
      message: 'upstream error',
      detail: 'connection failed',
    });

    await handle.close();
  });

  it('socket error 与 close 不受注入确认窗影响，仍是连接级事件', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    handle.injectItem('播报任务失败');
    upstream.emit('error', new Error('socket gone'));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'UPSTREAM_SOCKET',
      message: 'upstream socket error',
      detail: 'socket gone',
    });

    upstream.emit('close');
    expect(events.at(-1)).toEqual({ type: 'state', state: 'closed' });
  });

  it('turn_detection 关闭时 response.done 不报 ttfaPerceivedMs', async () => {
    mockConfig.settings = { voice: { turnDetection: null, live: { interrupt: 'manual' } } };
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

  // 批 H：焦点变化/切专家要增量刷 instructions。这是 Base 上的能力，
  // 两种形态都得有——少一个就是「换个 provider 上下文注入静默失效」。
  it('两种形态都实现 updateInstructions（不是 relay 独有）', async () => {
    const relay = await connectHandle(qwenOmniTransport);
    expect(typeof relay.updateInstructions).toBe('function');
    await relay.close();

    const direct = await connectHandle(fakeDirectTransport);
    expect(typeof direct.updateInstructions).toBe('function');
    await direct.close();
  });

  it('relay 的 updateInstructions 只发 instructions，不重发整份 session', async () => {
    const handle = await connectHandle(qwenOmniTransport);
    const upstream = upstreams[upstreams.length - 1];
    upstream.sent.length = 0;

    handle.updateInstructions('你是牧之\n\n[Context — Focus]\n- 当前文件：/repo/a.ts');

    const frames = upstream.sent.map((raw) => JSON.parse(raw) as { type: string; session?: Record<string, unknown> });
    const update = frames.find((frame) => frame.type === 'session.update');
    expect(update?.session).toEqual({ instructions: '你是牧之\n\n[Context — Focus]\n- 当前文件：/repo/a.ts' });
    // 重发 turn_detection / tools 会把上游按模型分化过的行为重新赌一遍，不做。
    expect(update?.session).not.toHaveProperty('turn_detection');
    expect(update?.session).not.toHaveProperty('tools');

    await handle.close();
  });

  // 删「按住说话」档留下的老配置形状：turnDetection: null（手动 commit）
  // 但 live.interrupt 是已下线的 push_to_talk。UI 侧把它归一成全双工了，
  // 运行时若还按 null 走 = UI 说全双工、上游永远等不到 commit，用户说了没反应。
  it('老 push_to_talk 配置不再让上游停在手动 commit 档', async () => {
    mockConfig.settings = { voice: { turnDetection: null, live: { interrupt: 'push_to_talk' as never } } };
    const handle = await connectHandle(qwenOmniTransport);
    const upstream = upstreams[upstreams.length - 1];

    expect(readSessionUpdate(upstream).session.turn_detection).toMatchObject({ type: 'server_vad' });

    await handle.close();
  });

  // 工单③：通话模型可配。判据打在「WS URL 里的 ?model= 真是什么」，不是「字段被赋了值」。
  it('config.model 真进 WS URL 的 ?model=；未传时回落默认常量', async () => {
    const explicit = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', model: 'qwen3-omni-flash-realtime' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    expect(upstreams[upstreams.length - 1].url).toContain('?model=qwen3-omni-flash-realtime');
    await explicit.close();

    const fallback = await connectHandle(qwenOmniTransport);
    expect(upstreams[upstreams.length - 1].url).toContain(`?model=${QWEN_OMNI_REALTIME_MODEL}`);
    await fallback.close();
  });

  // 工单③ fail-loud 兜底：上一代模型对 tools 是「收下不报错、回显 null」——
  // 判据是「用户可见的 notice 真发出去了」，不是「logger.warn 被调了」。
  it('注册了 tools 但 session.updated 回显 tools: null → 发用户可见 notice，一条连接只发一次', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [{ type: 'function', name: 'get_active_tasks', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }] },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
      onToolCall: async () => 'ok',
    });
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({ type: 'session.updated', session: { tools: null } }));
    // 上游可能刷多条 session.updated（比如 focus 刷新后），提示只该出现一次
    upstream.emit('message', JSON.stringify({ type: 'session.updated', session: {} }));

    const notices = events.filter((event) => event.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'notice', code: 'VOICE_TOOLS_DROPPED' });

    await handle.close();
  });

  it('session.updated 回显真收下了 tools → 不发 notice', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [{ type: 'function', name: 'get_active_tasks', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }] },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
      onToolCall: async () => 'ok',
    });
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'session.updated',
      session: { tools: [{ type: 'function', name: 'get_active_tasks' }] },
    }));

    expect(events.filter((event) => event.type === 'notice')).toHaveLength(0);

    await handle.close();
  });
});
