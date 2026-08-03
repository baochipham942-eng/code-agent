// @vitest-environment jsdom
// 挂断僵尸重连（批 X5 ①，2026-07-30 真机）：host 主动结束这一路时，renderer 曾把它
// 当网络抖动接回来——2 秒后自动拨出一通新电话，通话条不落、计时继续走。
// 这里两向都钉：终止 close code 不重连；抖动（1006）照旧重连。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_WS_CLOSE_TERMINAL } from '../../../src/shared/constants/voice';

// error 是 T3 的 silent 档呈现要用的（收回 chrome + toast）；两批合体后这条路径会走到它。
const toastMocks = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const ipcMocks = vi.hoisted(() => ({ invokeDomain: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: toastMocks.info, error: toastMocks.error },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: ipcMocks.invokeDomain,
  },
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  isNativeDesktopAvailable: () => false,
}));
vi.mock('../../../src/renderer/services/voiceEchoHint', () => ({
  maybeShowSpeakerEchoHint: vi.fn(async () => undefined),
  showVoiceAecFallbackWarning: vi.fn(),
}));
vi.mock('../../../src/renderer/services/voiceAudioPipeline', () => ({
  VoiceAudioPipeline: class {
    setCaptureOpen() {}
    async start() {}
    stop() {}
    setMuted() {}
    enqueuePlayback() {}
    clearPlayback() {}
  },
}));
vi.mock('../../../src/renderer/services/nativeVoiceAudioPipeline', () => ({
  NativeVoiceAudioPipeline: class {
    setCaptureOpen() {}
    async start() {}
    stop() {}
    setMuted() {}
    enqueuePlayback() {}
    clearPlayback() {}
  },
}));

const { voiceCallBridge } = await import('../../../src/renderer/services/voiceCallBridge');
const { useVoiceCallStore } = await import('../../../src/renderer/stores/voiceCallStore');

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send() {}
  close() {
    this.readyState = 3;
  }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateError() {
    this.onerror?.();
  }
  simulateClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  simulateEvent(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

let sockets: FakeWebSocket[] = [];

/** 拨通到「socket 已 open」为止，返回那条 socket。 */
async function dialAndOpen(): Promise<FakeWebSocket> {
  await voiceCallBridge.dial('session-1');
  const socket = sockets[sockets.length - 1];
  socket.simulateOpen();
  await Promise.resolve();
  return socket;
}

describe('voiceCallBridge 终止关闭 vs 网络抖动', () => {
  beforeEach(() => {
    sockets = [];
    toastMocks.info.mockClear();
    ipcMocks.invokeDomain.mockReset().mockImplementation(async (domain: string) => (
      domain === 'domain:settings'
        ? { voice: { live: { interrupt: 'server_vad', echoCancellation: 'off' } } }
        : undefined
    ));
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    });
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useVoiceCallStore.getState().reset();
  });

  it('host 带终止 close code 关闭：不重连、通话状态就地落定', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    socket.simulateClose(VOICE_WS_CLOSE_TERMINAL);
    // 退避表最长一档 4000ms，多跑一截保证「真的没排重连」而不是「还没到点」
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(1);
    expect(useVoiceCallStore.getState().phase).toBe('idle');
    expect(useVoiceCallStore.getState().reconnecting).toBe(false);
  });

  it('首次握手失败只通过 voice IPC 上报一次', async () => {
    await voiceCallBridge.dial('session-handshake-failed');
    const socket = sockets[0];

    socket.simulateError();
    socket.simulateClose(1006);

    await vi.waitFor(() => expect(ipcMocks.invokeDomain).toHaveBeenCalledWith(
      'domain:voice',
      'reportFailure',
      {
        neoSessionId: 'session-handshake-failed',
        code: 'HANDSHAKE_FAILED',
        phase: 'handshake',
      },
    ));
    expect(ipcMocks.invokeDomain.mock.calls.filter(([domain]) => domain === 'domain:voice')).toHaveLength(1);
  });

  it('网络抖动（非终止 code）仍进重连：接回同一通电话', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    socket.simulateClose(1006);
    expect(useVoiceCallStore.getState().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets).toHaveLength(2);
  });

  it('重连退避耗尽后通过 voice IPC 上报 RECONNECT_FAILED', async () => {
    const socket = await dialAndOpen();
    vi.useFakeTimers();

    socket.simulateClose(1006);
    for (const delay of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(delay);
      sockets[sockets.length - 1].simulateClose(1006);
    }

    expect(ipcMocks.invokeDomain).toHaveBeenCalledWith('domain:voice', 'reportFailure', {
      neoSessionId: 'session-1',
      code: 'RECONNECT_FAILED',
      phase: 'reconnect',
    });
  });

  it('空闲结束回到 idle 并给信息提示，不进入红色 error 态', async () => {
    const socket = await dialAndOpen();
    socket.simulateEvent({ type: 'state', state: 'live' });

    socket.simulateEvent({ type: 'session.ended', reason: 'idle-timeout' });

    expect(useVoiceCallStore.getState().phase).toBe('idle');
    expect(useVoiceCallStore.getState().error).toBeNull();
    expect(toastMocks.info).toHaveBeenCalledWith('长时间没有对话，通话已自动结束');
  });
});
