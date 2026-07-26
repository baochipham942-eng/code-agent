// @vitest-environment jsdom
// 回归：dial() 触发的重渲染不得关闭刚建立的通话 WS。
// 首跑真机时就是这个 bug——清理函数挂在每渲染换身份的依赖上，握手还没完成就被 abort。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';

// 按名字枚举的 mock 会在 constants 每次新增导出时炸（连坐无关测试）。
// spread 真实模块后只覆盖本测试要改的键。
vi.mock('@shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/constants')>()),
  VOICE_STREAM_WS_PATH: '/api/voice/stream',
  VOICE_DEV_FLAG_KEY: 'code-agent:voice-spike',
  VOICE_UPSTREAM_SAMPLE_RATE: 16000,
  VOICE_DOWNSTREAM_SAMPLE_RATE: 24000,
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-1' }),
}));
vi.mock('../../../src/renderer/hooks/useRealtimeVoiceAudio', () => ({
  useRealtimeVoiceAudio: () => ({
    // 故意每次渲染返回新对象，模拟未 memo 化的调用方
    start: async () => undefined,
    stop: () => undefined,
    enqueuePlayback: () => undefined,
    clearPlayback: () => undefined,
    micLevel: 0,
    framesSent: 0,
    error: null,
  }),
}));

const { VoiceSpikePanel } = await import('../../../src/renderer/components/features/voice/VoiceSpikePanel');

const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  closeCount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
  }
  addEventListener() {}
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closeCount += 1;
  }
}

describe('VoiceSpikePanel 通话生命周期', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeSocket);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:8181' },
      writable: true,
    });
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ = 'tok';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('点击拨号后 WS 不被本次重渲染关闭', () => {
    const { getByText } = render(<VoiceSpikePanel />);
    act(() => {
      fireEvent.click(getByText('开始通话'));
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('/api/voice/stream');
    expect(sockets[0].url).toContain('token=tok');
    expect(sockets[0].closeCount).toBe(0); // ← 首跑真机时这里是 1
  });

  it('卸载时挂断并关闭 WS', () => {
    const { getByText, unmount } = render(<VoiceSpikePanel />);
    act(() => {
      fireEvent.click(getByText('开始通话'));
    });
    unmount();
    expect(sockets[0].closeCount).toBe(1);
  });
});
