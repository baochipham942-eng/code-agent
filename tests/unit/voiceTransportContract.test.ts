// VoiceTransport 契约双跑（方案 §9.2 / §13.3 第 1 条）：
// relay 形态必须实现 sendAudio（媒体经 Host 中继），direct 形态必须给出
// clientBootstrap（Renderer 直连上游）。判别联合把「永远不该被调用的 no-op」
// 从接口上消灭，本测试钉住两侧真跑出来的 handle 形态——真 OpenAI adapter 未落地，
// direct 侧用 fake adapter 钉形态。
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { VoiceEvent, VoiceTransport, VoiceTransportHandle, VoiceTurnDetectionConfig } from '../../src/shared/contract/voice';
import {
  QWEN_OMNI_REALTIME_MODEL,
  VOICE_INJECTION_ACK_WINDOW_MS,
  VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS,
  VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS,
} from '../../src/shared/constants/voice';
import { REALTIME_VOICE_PROVIDER_PROFILES } from '../../src/shared/constants/realtimeVoiceProviders';

/** 最小 ws 替身：qwenOmniTransport 只用到 open/error 事件、send、readyState、close。 */
class FakeUpstream extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  url = '';
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
    const event = JSON.parse(data) as { type?: string; session?: Record<string, unknown> };
    if (event.type === 'session.update' && sessionUpdatedReplyDelayMs !== null) {
      const reply = () => this.emit('message', JSON.stringify({
        type: 'session.updated',
        session: event.session,
      }));
      if (sessionUpdatedReplyDelayMs === 0) queueMicrotask(reply);
      else setTimeout(reply, sessionUpdatedReplyDelayMs);
    }
  }
  ping() {
    this.emit('pong');
  }
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
}

const upstreams: FakeUpstream[] = [];
let sessionUpdatedReplyDelayMs: number | null = 0;
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const telemetry = vi.hoisted(() => ({
  startSpan: vi.fn(() => ({ spanId: 'voice-watchdog-span' })),
  endSpan: vi.fn(),
}));
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
  createLogger: () => logger,
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => mockConfig.settings }),
}));
vi.mock('../../src/host/telemetry/telemetryService', () => ({
  getTelemetryService: () => telemetry,
}));

const { qwenOmniTransport } = await import('../../src/host/services/voice/qwenOmniTransport');
const { createRealtimeTransport } = await import('../../src/host/services/voice/realtimeTransport');
const openaiRealtimeTransport = createRealtimeTransport(REALTIME_VOICE_PROVIDER_PROFILES['openai-realtime']);

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
    sessionUpdatedReplyDelayMs = 0;
    mockConfig.settings = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    // 批 X5：silence 1000 / prefix 500（800 档真机仍把真人犹豫切断，2026-07-30）
    expect(update.session.turn_detection).toEqual({
      type: 'server_vad',
      create_response: false,
      interrupt_response: false,
      threshold: 0.5,
      prefix_padding_ms: 500,
      silence_duration_ms: 1000,
    });

    await handle.close();
  });

  it('存量配置里的历代旧默认 prefix/silence 读取时升级为新默认，手改值保留', async () => {
    // prefix/silence 从来不是 UI 可设项，落盘等于历代默认之一只可能是旧默认拷贝——
    // 「改默认值对存量用户零生效」是踩过的坑，读取口必须升级（批 X2 / X5）。
    mockConfig.settings = { voice: { turnDetection: { type: 'server_vad', threshold: 0.7, prefixPaddingMs: 300, silenceDurationMs: 500 } } };
    let handle = await connectHandle(qwenOmniTransport);
    expect(readSessionUpdate(upstreams[upstreams.length - 1]).session.turn_detection).toEqual({
      type: 'server_vad',
      create_response: false,
      interrupt_response: false,
      threshold: 0.7, // 手选灵敏度保留
      prefix_padding_ms: 500,
      silence_duration_ms: 1000,
    });
    await handle.close();

    // 批 X5：上一版默认 800 同样是拷贝，跟着升到 1000——只升 500 会把批 X2 之后
    // 保存过配置的人永久钉死在 800 档（他们正是这次真机报「仍被切断」的那批）。
    mockConfig.settings = { voice: { turnDetection: { type: 'server_vad', prefixPaddingMs: 500, silenceDurationMs: 800 } } };
    handle = await connectHandle(qwenOmniTransport);
    expect(readSessionUpdate(upstreams[upstreams.length - 1]).session.turn_detection).toEqual({
      type: 'server_vad',
      create_response: false,
      interrupt_response: false,
      prefix_padding_ms: 500,
      silence_duration_ms: 1000,
    });
    await handle.close();

    // 手改过的实验值（非旧默认）原样保留，别把调参路堵死
    mockConfig.settings = { voice: { turnDetection: { type: 'server_vad', threshold: 0.5, prefixPaddingMs: 450, silenceDurationMs: 600 } } };
    handle = await connectHandle(qwenOmniTransport);
    expect(readSessionUpdate(upstreams[upstreams.length - 1]).session.turn_detection).toEqual({
      type: 'server_vad',
      create_response: false,
      interrupt_response: false,
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

    expect(update.session.turn_detection).toEqual({
      type: 'semantic_vad',
      create_response: false,
      interrupt_response: false,
      eagerness: 'high',
    });

    await handle.close();
  });

  // E3（2026-07-30 真上游探针）：用户侧增量文本在 `stash` 里，`text` 字段恒空。
  // 照抄助手侧读 `delta`/`text` 的写法就是「上游一直在发、我们一直丢」。
  it('用户转写 delta 从 stash 取文本，边说边下发 done:false', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1', text: '', stash: '你好',
    }));
    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1', text: '', stash: '你好，帮我',
    }));

    const partials = events.filter((e) => e.type === 'user.transcript' && !e.done);
    expect(partials).toHaveLength(2);
    expect(partials[1]).toMatchObject({ text: '你好，帮我', done: false, candidateId: 'turn-1' });
    await handle.close();
  });

  // E1（P0）：completed 的 transcript 间歇性为空，此前空文本一路走到落库前被静默丢弃，
  // 25 秒通话两轮用户字幕全部蒸发。delta 攒下的 stash 是同一句话，必须兜住。
  it('completed 的 transcript 为空时回落到 delta 攒下的文本，并打 warn', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1', text: '', stash: '你好，帮我看一下',
    }));
    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1', transcript: '',
    }));

    const final = events.find((e) => e.type === 'user.transcript' && e.done);
    expect(final).toMatchObject({ text: '你好，帮我看一下', done: true });
    await handle.close();
  });

  it('completed 有 transcript 时以它为准（不被 stash 覆盖）', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1', text: '', stash: '你好帮我看',
    }));
    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1', transcript: '你好，帮我看一下这个文件',
    }));

    const final = events.find((e) => e.type === 'user.transcript' && e.done);
    expect(final).toMatchObject({ text: '你好，帮我看一下这个文件' });
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
    // perceived = model + silence 窗（批 X5 起默认 1000；抬窗的代价如实计进这个口径）
    expect(done).toMatchObject({ type: 'response.done', ttfaModelMs: 427, ttfaPerceivedMs: 1427 });

    nowSpy.mockRestore();
    await handle.close();
  });

  it('DashScope response.done 只按复数 input_tokens_details/output_tokens_details 解析 usage', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    upstreams.at(-1)?.emit('message', JSON.stringify({
      type: 'response.done',
      response: {
        id: 'dash-usage',
        usage: {
          total_tokens: 377,
          input_tokens: 336,
          output_tokens: 41,
          input_tokens_details: { text_tokens: 228, audio_tokens: 108 },
          output_tokens_details: { text_tokens: 9, audio_tokens: 32 },
        },
      },
    }));

    expect(events.find((event) => event.type === 'response.done')).toMatchObject({
      usage: {
        totalTokens: 377,
        inputTokens: 336,
        outputTokens: 41,
        inputAudioTokens: 108,
        inputTextTokens: 228,
        outputAudioTokens: 32,
        outputTextTokens: 9,
      },
    });
    await handle.close();
  });

  it('DashScope 稀疏 details（缺席字段按 0）也要解析成功——真机纯文本输入的实际形状', async () => {
    // fixture 来自 2026-08-13 直连 DashScope 真机探针抓到的 response.done.usage 原始载荷：
    // 纯文本输入时 input_tokens_details 只有 text_tokens、没有 audio_tokens 字段。
    // 全字段严格校验把它整体拒收，正是 08-06 C3「成本到限提醒 FAIL」的根因。
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    upstreams.at(-1)?.emit('message', JSON.stringify({
      type: 'response.done',
      response: {
        id: 'dash-sparse-usage',
        usage: {
          total_tokens: 484,
          input_tokens: 475,
          output_tokens: 9,
          input_tokens_details: { text_tokens: 475 },
          output_tokens_details: { text_tokens: 2, audio_tokens: 7 },
        },
      },
    }));

    expect(events.find((event) => event.type === 'response.done')).toMatchObject({
      usage: {
        totalTokens: 484,
        inputTokens: 475,
        outputTokens: 9,
        inputAudioTokens: 0,
        inputTextTokens: 475,
        outputAudioTokens: 7,
        outputTextTokens: 2,
      },
    });
    await handle.close();
  });

  it('OpenAI response.done 只按单数 input_token_details/output_token_details 解析 usage', async () => {
    const events: VoiceEvent[] = [];
    const handle = await openaiRealtimeTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    upstreams.at(-1)?.emit('message', JSON.stringify({
      type: 'response.done',
      response: {
        id: 'openai-usage',
        usage: {
          total_tokens: 253,
          input_tokens: 132,
          output_tokens: 121,
          input_token_details: { text_tokens: 119, audio_tokens: 13, image_tokens: 0, cached_tokens: 64 },
          output_token_details: { text_tokens: 30, audio_tokens: 91 },
        },
      },
    }));

    expect(events.find((event) => event.type === 'response.done')).toMatchObject({
      usage: {
        totalTokens: 253,
        inputTokens: 132,
        outputTokens: 121,
        inputAudioTokens: 13,
        inputTextTokens: 119,
        outputAudioTokens: 91,
        outputTextTokens: 30,
      },
    });
    await handle.close();
  });

  it.each([
    ['上游没给 usage', undefined],
    ['usage 形状不认识', { total_tokens: 1, input_token_details: {}, output_token_details: {} }],
  ])('%s 时 usage 留空并 warn', async (_label, usage) => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    upstreams.at(-1)?.emit('message', JSON.stringify({
      type: 'response.done',
      response: { id: 'unknown-usage', ...(usage === undefined ? {} : { usage }) },
    }));

    const done = events.find((event) => event.type === 'response.done');
    expect(done).toBeDefined();
    expect(done).not.toHaveProperty('usage');
    expect(logger.warn).toHaveBeenCalledWith(
      'response.done usage missing or unrecognized',
      expect.objectContaining({ provider: 'dashscope-qwen-omni', hasUsage: usage !== undefined }),
    );
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

  it('贯穿 responseId/itemId，取消返回被取消 response，并隔离晚到 done', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-old' },
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-old',
      item_id: 'item-old',
      delta: '旧回答',
    }));
    expect(handle.interrupt()).toBe('resp-old');
    expect(events.at(-1)).toMatchObject({
      type: 'assistant.transcript',
      responseId: 'resp-old',
      itemId: 'item-old',
    });

    upstream.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-new' },
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.done',
      response: { id: 'resp-old' },
    }));
    expect(handle.isResponding()).toBe(true);

    upstream.emit('message', JSON.stringify({
      type: 'response.done',
      response: { id: 'resp-new' },
    }));
    expect(handle.isResponding()).toBe(false);
    expect(events.filter((event) => event.type === 'response.done')).toEqual([
      expect.objectContaining({ responseId: 'resp-old' }),
      expect.objectContaining({ responseId: 'resp-new' }),
    ]);

    await handle.close();
  });

  it('assistant itemId 优先绑定 response.output_item.added，避免误用 transcript 帧的 item_id', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];
    upstream.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-new' },
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.output_item.added',
      response_id: 'resp-new',
      item: { id: 'assistant-item' },
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.done',
      response_id: 'resp-new',
      item_id: 'user-item',
      transcript: '新回答',
    }));

    expect(events.at(-1)).toMatchObject({
      type: 'assistant.transcript',
      responseId: 'resp-new',
      itemId: 'assistant-item',
      text: '新回答',
    });
    await handle.close();
  });

  it('取消旧 response 后只创建一次带最新用户 final 的新 response', async () => {
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-old' },
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-old',
      item_id: 'item-old',
      delta: '旧回答',
    }));
    expect(handle.interrupt()).toBe('resp-old');
    handle.respond('只执行最新要求：从十倒数到一');
    handle.respond('只执行最新要求：从十倒数到一');
    expect(upstream.sent.filter((raw) => JSON.parse(raw).type === 'response.create')).toHaveLength(0);

    upstream.emit('message', JSON.stringify({
      type: 'response.done',
      response: { id: 'resp-old' },
    }));
    expect(upstream.sent.map((raw) => JSON.parse(raw)).filter((frame) =>
      frame.type === 'conversation.item.delete' || frame.type === 'response.create',
    )).toEqual([
      { type: 'conversation.item.delete', item_id: 'item-old' },
      {
        type: 'response.create',
        response: { instructions: '只执行最新要求：从十倒数到一' },
      },
    ]);
    expect(upstream.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'response.create'))
      .toEqual([{
        type: 'response.create',
        response: { instructions: '只执行最新要求：从十倒数到一' },
      }]);

    await handle.close();
  });

  it('required 只约束当前用户轮，工具结果续答前恢复 auto', async () => {
    const onToolCall = vi.fn(async () => '已派发');
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: {
        neoSessionId: 's1',
        tools: [{
          type: 'function',
          name: 'delegate_task',
          description: '派发任务',
          parameters: { type: 'object', properties: {}, required: [] },
        }],
      },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
      onToolCall,
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];
    const sentBeforeResponse = upstream.sent.length;

    handle.respond('只执行最新要求', 'required');
    expect(upstream.sent.slice(sentBeforeResponse).map((raw) => JSON.parse(raw))).toEqual([
      { type: 'session.update', session: { tool_choice: 'required' } },
      { type: 'response.create', response: { instructions: '只执行最新要求' } },
    ]);
    expect(handle.isResponding()).toBe(true);
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-tool' } }));

    upstream.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'delegate_task',
      arguments: '{}',
    }));
    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledTimes(1));
    expect(upstream.sent.slice(sentBeforeResponse).map((raw) => JSON.parse(raw))).toContainEqual({
      type: 'session.update',
      session: { tool_choice: 'auto' },
    });
    await vi.waitFor(() => {
      const responseCreates = upstream.sent
        .slice(sentBeforeResponse)
        .map((raw) => JSON.parse(raw) as { type?: string })
        .filter((frame) => frame.type === 'response.create');
      expect(responseCreates).toHaveLength(2);
    });
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-tool' } }));
    expect(handle.isResponding()).toBe(true);
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-result' } }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-result' } }));
    expect(handle.isResponding()).toBe(false);

    await handle.close();
  });

  it('XML fallback：纯 invoke 从字幕和音频剥除，response.done 后走同一工具出口', async () => {
    const events: VoiceEvent[] = [];
    const onAudio = vi.fn();
    const onToolCall = vi.fn(async () => '已派发');
    const spawnTool = {
      type: 'function' as const,
      name: 'delegate_task',
      description: '派发任务',
      parameters: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' },
          short_name: { type: 'string' },
          lane_key: { type: 'string' },
          submission_key: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['title', 'short_name', 'lane_key', 'submission_key', 'prompt'],
        additionalProperties: false,
      },
    };
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [spawnTool] },
      onEvent: (event) => events.push(event),
      onAudio,
      onToolCall,
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];
    const transcript = '<invoke name="delegate_task">'
      + '<parameter name="title">生成周报</parameter>'
      + '<parameter name="short_name">周报</parameter>'
      + '<parameter name="lane_key">weekly</parameter>'
      + '<parameter name="submission_key">turn-1</parameter>'
      + '<parameter name="prompt">生成本周报告</parameter>'
      + '</invoke>';

    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-xml' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'resp-xml',
      delta: Buffer.from([1, 2]).toString('base64'),
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-xml',
      delta: '<invoke',
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.done',
      response_id: 'resp-xml',
      transcript,
    }));
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onAudio).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'assistant.transcript')).toEqual([]);

    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-xml' } }));
    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledWith({
      callId: 'xml-fallback-resp-xml-1',
      name: 'delegate_task',
      arguments: JSON.stringify({
        title: '生成周报',
        short_name: '周报',
        lane_key: 'weekly',
        submission_key: 'turn-1',
        prompt: '生成本周报告',
      }),
      origin: 'xml_fallback',
    }));
    await handle.close();
  });

  it('XML fallback：畸形、未知与用户转写均不执行，真调用与伪调用按 response 去重', async () => {
    const events: VoiceEvent[] = [];
    const onToolCall = vi.fn(async () => '状态已返回');
    const statusTool = {
      type: 'function' as const,
      name: 'task_status',
      description: '查询状态',
      parameters: { type: 'object' as const, properties: {}, required: [], additionalProperties: false },
    };
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [statusTool] },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
      onToolCall,
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: '<invoke name="task_status"></invoke>',
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'user.transcript', itemId: 'user-1' }));
    expect(onToolCall).not.toHaveBeenCalled();

    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-bad' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.done',
      response_id: 'resp-bad',
      transcript: '<invoke name="task_status"><parameter name="extra">x</parameter></invoke>',
    }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-bad' } }));
    expect(onToolCall).not.toHaveBeenCalled();

    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-dupe' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.done',
      response_id: 'resp-dupe',
      transcript: '<invoke name="task_status"></invoke>',
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-dupe',
      call_id: 'call-real',
      name: 'task_status',
      arguments: '{}',
    }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-dupe' } }));
    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledTimes(1));
    expect(onToolCall).toHaveBeenCalledWith({
      callId: 'call-real',
      name: 'task_status',
      arguments: '{}',
      origin: 'function_call',
    });
    await handle.close();
  });

  it('旧 response.done 先于当前用户 final 时不删除 item、不截断 ASR', async () => {
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];
    upstream.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-old' },
    }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-old',
      item_id: 'item-old',
      delta: '旧回答',
    }));

    expect(handle.interrupt()).toBe('resp-old');
    upstream.emit('message', JSON.stringify({
      type: 'response.done',
      response: { id: 'resp-old' },
    }));
    expect(upstream.sent.map((raw) => JSON.parse(raw)).filter((frame) =>
      frame.type === 'conversation.item.delete' || frame.type === 'response.create',
    )).toHaveLength(0);

    handle.respond('最新用户 final');
    expect(upstream.sent.map((raw) => JSON.parse(raw)).filter((frame) =>
      frame.type === 'conversation.item.delete' || frame.type === 'response.create',
    )).toEqual([
      { type: 'conversation.item.delete', item_id: 'item-old' },
      { type: 'response.create', response: { instructions: '最新用户 final' } },
    ]);

    await handle.close();
  });

  it('已提交轮次持续哑火时先 nudge，再发一次性 notice；看门狗 response.create 不算注入', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    const upstream = upstreams[upstreams.length - 1];
    const sentBeforeCommit = upstream.sent.length;

    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    if (handle.kind === 'relay') handle.respond();
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS);

    const firstTurnFrames = upstream.sent
      .slice(sentBeforeCommit)
      .map((raw) => JSON.parse(raw) as { type: string });
    expect(firstTurnFrames.filter((frame) => frame.type === 'response.create')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(0);

    upstream.emit('message', JSON.stringify({
      type: 'error',
      error: { message: 'nudge rejected' },
    }));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'UPSTREAM_ERROR' });

    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(1);

    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    if (handle.kind === 'relay') handle.respond();
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 2);
    const responseCreates = upstream.sent
      .slice(sentBeforeCommit)
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((frame) => frame.type === 'response.create');
    expect(responseCreates).toHaveLength(4);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(1);

    await handle.close();
  });

  it('已提交轮次很快收到 created + delta + done 时看门狗零动作', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    const upstream = upstreams[upstreams.length - 1];
    const sentBeforeCommit = upstream.sent.length;

    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    await vi.advanceTimersByTimeAsync(1_000);
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-fast' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-fast',
      delta: '正常回复',
    }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-fast' } }));
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 2);

    const frames = upstream.sent.slice(sentBeforeCommit).map((raw) => JSON.parse(raw) as { type: string });
    expect(frames.filter((frame) => frame.type === 'response.create')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(0);

    await handle.close();
  });

  it('P1: created 后增量停滞会 cancel + 重建，重建恢复后无用户打扰', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    handle.respond('原始轮次指令');
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-original' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-original',
      delta: '正在',
    }));
    await vi.advanceTimersByTimeAsync(100);
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-original',
      delta: '回复',
    }));

    const beforeSilence = upstream.sent.length;
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS);
    expect(upstream.sent.slice(beforeSilence).map((raw) => JSON.parse(raw))).toEqual([
      { type: 'response.cancel' },
      { type: 'response.create', response: { instructions: '原始轮次指令' } },
    ]);

    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-rebuilt' } }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-original' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'resp-rebuilt',
      delta: Buffer.from([1, 2]).toString('base64'),
    }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-rebuilt' } }));
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 3);

    expect(upstream.sent.filter((raw) => (JSON.parse(raw) as { type?: string }).type === 'response.cancel')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(0);
    await handle.close();
  });

  it('P2: 重建仍哑会记健康减分并且用户 notice 只发一次', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    handle.respond('需要恢复的轮次');
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-original' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-original',
      delta: '开始',
    }));
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS);
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-rebuilt' } }));
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 6);

    expect(logger.warn).toHaveBeenCalledWith(
      'upstream response watchdog rebuild still silent',
      expect.objectContaining({ responseId: 'resp-rebuilt', healthScore: -1 }),
    );
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(1);

    handle.respond('第二个需要恢复的轮次');
    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-second-original' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-second-original',
      delta: '第一帧',
    }));
    await vi.advanceTimersByTimeAsync(4_000);
    upstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-second-original',
      delta: '第二帧',
    }));
    await vi.advanceTimersByTimeAsync(16_000);

    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_SERVICE_UNSTABLE')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS);
    expect(logger.warn).toHaveBeenCalledWith(
      'upstream response watchdog rebuild still silent',
      expect.objectContaining({
        responseId: 'resp-second-original',
        healthScore: -2,
        thresholdMs: VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS,
        degraded: true,
      }),
    );
    expect(telemetry.startSpan).toHaveBeenCalledTimes(2);
    expect(telemetry.startSpan).toHaveBeenLastCalledWith(
      'watchdog_takeover',
      'internal',
      expect.objectContaining({
        'voice_watchdog.response_id': 'resp-second-original',
        'voice_watchdog.takeover_count': 2,
      }),
    );
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(1);
    await handle.close();
  });

  it('N1: tool_call response.done 后工具等待 120s 看门狗零动作', async () => {
    vi.useFakeTimers();
    const tool = { type: 'function' as const, name: 'long_task', description: 'd', parameters: { type: 'object', properties: {}, required: [] } };
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [tool] },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
      onToolCall: vi.fn(() => new Promise<string>(() => undefined)),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-tool' } }));
    upstream.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-tool',
      call_id: 'call-tool',
      name: 'long_task',
      arguments: '{}',
    }));
    upstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-tool' } }));
    const beforeWait = upstream.sent.length;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(upstream.sent.slice(beforeWait).filter((raw) => {
      const type = (JSON.parse(raw) as { type?: string }).type;
      return type === 'response.cancel' || type === 'response.create';
    })).toHaveLength(0);
    await handle.close();
  });

  it('N2: 用户说话期和 ending 工具收尾期各静默 120s 都零动作', async () => {
    vi.useFakeTimers();
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const speakingHandle = await connecting;
    const speakingUpstream = upstreams[upstreams.length - 1];
    speakingUpstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-speaking' } }));
    speakingUpstream.emit('message', JSON.stringify({
      type: 'response.audio_transcript.delta',
      response_id: 'resp-speaking',
      delta: '未说完',
    }));
    speakingUpstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    const beforeSpeakingWait = speakingUpstream.sent.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(speakingUpstream.sent.slice(beforeSpeakingWait).filter((raw) =>
      (JSON.parse(raw) as { type?: string }).type === 'response.cancel',
    )).toHaveLength(0);
    await speakingHandle.close();

    const endCallTool = { type: 'function' as const, name: 'end_call', description: 'd', parameters: { type: 'object', properties: {}, required: [] } };
    const endingConnecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1', tools: [endCallTool] },
      onEvent: vi.fn(),
      onAudio: vi.fn(),
      onToolCall: vi.fn(() => new Promise<string>(() => undefined)),
    });
    await vi.advanceTimersByTimeAsync(0);
    const endingHandle = await endingConnecting;
    const endingUpstream = upstreams[upstreams.length - 1];
    endingUpstream.emit('message', JSON.stringify({ type: 'response.created', response: { id: 'resp-ending' } }));
    endingUpstream.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-ending',
      call_id: 'call-ending',
      name: 'end_call',
      arguments: '{}',
    }));
    endingUpstream.emit('message', JSON.stringify({ type: 'response.done', response: { id: 'resp-ending' } }));
    const beforeEndingWait = endingUpstream.sent.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(endingUpstream.sent.slice(beforeEndingWait).filter((raw) => {
      const type = (JSON.parse(raw) as { type?: string }).type;
      return type === 'response.cancel' || type === 'response.create';
    })).toHaveLength(0);
    await endingHandle.close();
  });

  it('committed 后用户再次开口会解除已作废轮次的看门狗', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    const upstream = upstreams[upstreams.length - 1];
    const sentBeforeCommit = upstream.sent.length;

    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 2);

    const frames = upstream.sent.slice(sentBeforeCommit).map((raw) => JSON.parse(raw) as { type: string });
    expect(frames.filter((frame) => frame.type === 'response.create')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(0);

    await handle.close();
  });

  it('close 会清掉已武装的响应看门狗', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    const upstream = upstreams[upstreams.length - 1];
    const sentBeforeCommit = upstream.sent.length;

    upstream.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    await handle.close();
    await vi.advanceTimersByTimeAsync(VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS * 2);

    const frames = upstream.sent.slice(sentBeforeCommit).map((raw) => JSON.parse(raw) as { type: string });
    expect(frames.filter((frame) => frame.type === 'response.create')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'notice' && event.code === 'VOICE_MODEL_UNRESPONSIVE')).toHaveLength(0);
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

  it('injectItemWithAck 在 response.created 时确认，injection.rejected 时拒绝', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay' || !handle.injectItemWithAck) throw new Error('missing relay injection ack');
    const upstream = upstreams[upstreams.length - 1];

    const accepted = handle.injectItemWithAck('[USER] 改做 Y');
    upstream.emit('message', JSON.stringify({ type: 'response.created', response_id: 'response-1' }));
    await expect(accepted).resolves.toBeUndefined();

    const rejected = handle.injectItemWithAck('[USER] 再改一次');
    upstream.emit('message', JSON.stringify({
      type: 'error',
      error: { message: 'Conversation already has an active response' },
    }));
    await expect(rejected).rejects.toThrow('Conversation already has an active response');
    expect(events.at(-1)).toEqual({
      type: 'injection.rejected',
      message: 'Conversation already has an active response',
    });

    await handle.close();
  });

  it('narration id 只投影到对应注入创建的 response', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    handle.injectItem('播报季度复盘', 'narration-1');
    upstream.emit('message', JSON.stringify({ type: 'response.created', response_id: 'response-1' }));
    expect(events.at(-1)).toEqual({
      type: 'response.created',
      responseId: 'response-1',
      narrationId: 'narration-1',
    });

    upstream.emit('message', JSON.stringify({ type: 'response.done', response_id: 'response-1' }));
    upstream.emit('message', JSON.stringify({ type: 'response.created', response_id: 'response-2' }));
    expect(events.at(-1)).toEqual({ type: 'response.created', responseId: 'response-2' });
    await handle.close();
  });

  it('fire-and-forget 播报未获 response.created 时释放注入锁并 fail-loud', async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = await connecting;
    if (handle.kind !== 'relay') throw new Error('unreachable');
    const upstream = upstreams[upstreams.length - 1];

    handle.injectItem('第一次播报', 'narration-1');
    await vi.advanceTimersByTimeAsync(VOICE_INJECTION_ACK_WINDOW_MS);
    expect(events.at(-1)).toEqual({
      type: 'injection.rejected',
      message: 'voice injection acknowledgement timed out',
    });

    handle.injectItem('第二次播报', 'narration-1');
    expect(upstream.sent.filter((raw) => JSON.parse(raw).type === 'conversation.item.create')).toHaveLength(2);
    await handle.close();
    vi.useRealTimers();
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

  it('300 秒无响应归为空闲结束，其他上游 error 仍归服务故障', async () => {
    const events: VoiceEvent[] = [];
    const handle = await qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: { neoSessionId: 's1' },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
    });
    const upstream = upstreams[upstreams.length - 1];

    upstream.emit('message', JSON.stringify({
      type: 'error',
      error: {
        code: 'response_idle_timeout',
        message: 'Your session was closed because no response was generated for 300 seconds.',
      },
    }));
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'idle-timeout' });

    upstream.emit('message', JSON.stringify({
      type: 'error',
      error: { code: 'COMMON_ERROR', message: 'upstream failed' },
    }));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'UPSTREAM_ERROR',
      message: 'upstream error',
      detail: 'upstream failed',
    });

    await handle.close();
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
    expect(onToolCall).toHaveBeenCalledWith({
      callId: 'call_1',
      name: 'get_active_tasks',
      arguments: '{}',
      origin: 'function_call',
    });
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

  it('初始 session.update 8s 无回显仍宣布 live，并按无 tools 通话发 dropped notice', async () => {
    vi.useFakeTimers();
    sessionUpdatedReplyDelayMs = null;
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: {
        neoSessionId: 'handshake-timeout',
        tools: [{
          type: 'function',
          name: 'get_active_tasks',
          description: 'List active tasks',
          parameters: { type: 'object', properties: {}, required: [] },
        }],
      },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
      onToolCall: async () => 'ok',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(events).not.toContainEqual({ type: 'state', state: 'live' });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(events).not.toContainEqual({ type: 'state', state: 'live' });

    await vi.advanceTimersByTimeAsync(1);
    const handle = await connecting;
    expect(events).toContainEqual({ type: 'state', state: 'live' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'notice',
      code: 'VOICE_TOOLS_DROPPED',
    }));
    expect(logger.info).toHaveBeenCalledWith(
      'initial session handshake timed out; continuing without tools',
      { voiceSessionId: 'handshake-timeout', waitMs: 8_000 },
    );
    await handle.close();
  });

  it('初始 session.updated 到达即宣布 live，不等满 8s 且不发 dropped notice', async () => {
    vi.useFakeTimers();
    sessionUpdatedReplyDelayMs = 25;
    const events: VoiceEvent[] = [];
    const connecting = qwenOmniTransport.connect({
      apiKey: 'test-key',
      config: {
        neoSessionId: 'handshake-confirmed',
        tools: [{
          type: 'function',
          name: 'get_active_tasks',
          description: 'List active tasks',
          parameters: { type: 'object', properties: {}, required: [] },
        }],
      },
      onEvent: (event) => events.push(event),
      onAudio: vi.fn(),
      onToolCall: async () => 'ok',
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(events).not.toContainEqual({ type: 'state', state: 'live' });

    await vi.advanceTimersByTimeAsync(1);
    const handle = await connecting;
    expect(events).toContainEqual({ type: 'state', state: 'live' });
    expect(events.filter((event) => event.type === 'notice')).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      'initial session handshake confirmed',
      { voiceSessionId: 'handshake-confirmed', waitMs: 25 },
    );
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
