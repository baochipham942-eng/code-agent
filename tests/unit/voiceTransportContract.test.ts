// VoiceTransport 契约双跑（方案 §9.2 / §13.3 第 1 条）：
// relay 形态必须实现 sendAudio（媒体经 Host 中继），direct 形态必须给出
// clientBootstrap（Renderer 直连上游）。判别联合把「永远不该被调用的 no-op」
// 从接口上消灭，本测试钉住两侧真跑出来的 handle 形态——真 OpenAI adapter 未落地，
// direct 侧用 fake adapter 钉形态。
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { VoiceTransport, VoiceTransportHandle } from '../../src/shared/contract/voice';

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
  getConfigService: () => ({ getSettings: () => ({}) }),
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

describe('VoiceTransport 契约（relay / direct 双跑）', () => {
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
