// @vitest-environment jsdom
// T3 启动期失败分档（方案 §4.2）+ BUSY 引导（§3.2）。
//
// 启动期（从未到达 live）的失败分两档：
//   silent 档（用户修不了：上游 5xx/429/握手失败）→ 收回通话槽位（reset）+ toast；
//   actionable 档（用户能修：权限/Key/设备/他窗占用）→ 保留 error 态 chrome。
// 到过 live 之后的中途断线/上游错误不受分档影响（回归门）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_WS_CLOSE_TERMINAL } from '../../../src/shared/constants/voice';
import { VOICE_STARTUP_FAILURE_TIER } from '../../../src/renderer/services/voiceStartupFailureTier';
import { voiceZh } from '../../../src/renderer/i18n/voice';

const toastMocks = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: toastMocks.info, error: toastMocks.error, success: toastMocks.success, warning: toastMocks.warning },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(async () => ({ voice: { live: { interrupt: 'server_vad', echoCancellation: 'off' } } })),
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

describe('voiceStartupFailureTier 分档表', () => {
  it('穷举 VoiceMessageCode 的每一个值（与 i18n 键集互校，类型层 Record 双保险）', () => {
    // 两张表都是 Record<VoiceMessageCode, ...> 定型：新增 code 漏写任一张，typecheck 先红；
    // 运行时再互校一次键集，防「绕开类型塞运行时键」。
    expect(Object.keys(VOICE_STARTUP_FAILURE_TIER).sort()).toEqual(
      Object.keys(voiceZh.voice.messageByCode).sort(),
    );
    for (const tier of Object.values(VOICE_STARTUP_FAILURE_TIER)) {
      expect(['actionable', 'silent']).toContain(tier);
    }
  });

  // 上面那条只钉「键集齐、值是两个合法字符串之一」——**它管不住档位填错**。
  // 2026-08-01 收口变异实测：把 MICROPHONE_PERMISSION_DENIED 从 actionable 翻成 silent，
  // 全套测试照样绿。而档位填错的后果是静默的错误呈现（用户明明去开个权限就能打，
  // 通话条却被直接收走、只剩一句转瞬即逝的 toast），恰恰是本单要消灭的那种失败。
  //
  // 所以整张表逐条钉死。每一条都是产品判断（"用户动得了手吗"），改它必须是显式决定：
  // 改表就得改这里，在 diff 上看得见，而不是悄悄换个词。
  it('逐条钉死每个 code 的档位——填错档位是静默的错误呈现', () => {
    expect(VOICE_STARTUP_FAILURE_TIER).toEqual({
      // 用户动得了手：换个窗口 / 去设置配 Key / 开权限 / 换设备 / 戴耳机
      VOICE_SESSION_BUSY: 'actionable',
      VOICE_PROVIDER_UNCONFIGURED: 'actionable',
      MICROPHONE_PERMISSION_DENIED: 'actionable',
      AUDIO_CAPTURE_FAILED: 'actionable',
      NATIVE_AEC_FAILED: 'actionable',
      // 通话中才产生，落不到启动失败出口；归 actionable = 保持既有呈现不变
      VOICE_TOOLS_DROPPED: 'actionable',
      VOICE_MODEL_UNRESPONSIVE: 'actionable',
      VOICE_WORK_FAILED: 'actionable',
      // 用户什么都做不了：上游 5xx / 429 / 连不上 / 退避耗尽
      VOICE_UPSTREAM_UNAVAILABLE: 'silent',
      UPSTREAM_SOCKET: 'silent',
      UPSTREAM_ERROR: 'silent',
      HANDSHAKE_FAILED: 'silent',
      RECONNECT_FAILED: 'silent',
    });
  });
});

describe('voiceCallBridge 启动期失败分档', () => {
  beforeEach(() => {
    sockets = [];
    toastMocks.info.mockClear();
    toastMocks.error.mockClear();
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

  it('B 档（silent）：启动期上游错误收回 chrome + toast，host 随后的终止关闭不复活', async () => {
    const socket = await dialAndOpen();

    socket.simulateEvent({ type: 'error', code: 'UPSTREAM_ERROR', message: 'upstream 500' });

    // 通话槽位被收回：不留红色僵尸 chrome
    expect(useVoiceCallStore.getState().phase).toBe('idle');
    expect(useVoiceCallStore.getState().error).toBeNull();
    expect(toastMocks.error).toHaveBeenCalledWith(voiceZh.voice.messageByCode.UPSTREAM_ERROR);

    // host 发完错误会带终止 close code 收尾：不得复活、不得再拨
    vi.useFakeTimers();
    socket.simulateClose(VOICE_WS_CLOSE_TERMINAL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useVoiceCallStore.getState().phase).toBe('idle');
    expect(sockets).toHaveLength(1);
  });

  it('B 档（silent）：首次握手失败同样收回 chrome + toast', async () => {
    await voiceCallBridge.dial('session-1');
    const socket = sockets[sockets.length - 1];

    // 从未 open：握手失败（onerror 没跟上、只有 onclose 的路径）
    socket.simulateClose(1006);

    expect(useVoiceCallStore.getState().phase).toBe('idle');
    expect(useVoiceCallStore.getState().error).toBeNull();
    expect(toastMocks.error).toHaveBeenCalledWith(voiceZh.voice.messageByCode.HANDSHAKE_FAILED);
  });

  it('A 档（actionable）正对照：启动期未配 Key 保留 chrome，reset 不被调用', async () => {
    const socket = await dialAndOpen();

    socket.simulateEvent({ type: 'error', code: 'VOICE_PROVIDER_UNCONFIGURED', message: '未配置 API Key' });

    // chrome 保留在 error 态等用户去配 Key，silent 路径的 toast 不得发出
    expect(useVoiceCallStore.getState().phase).toBe('error');
    expect(useVoiceCallStore.getState().error?.code).toBe('VOICE_PROVIDER_UNCONFIGURED');
    expect(toastMocks.error).not.toHaveBeenCalled();

    // host 随后终止关闭：error 态照旧不 reset（既有收尾规则）
    socket.simulateClose(VOICE_WS_CLOSE_TERMINAL);
    expect(useVoiceCallStore.getState().phase).toBe('error');
  });

  it('BUSY：保留 chrome，但走的是引导文案而不是裸错误', async () => {
    const socket = await dialAndOpen();

    socket.simulateEvent({ type: 'error', code: 'VOICE_SESSION_BUSY', message: '已有一路通话在进行中' });

    const state = useVoiceCallStore.getState();
    expect(state.phase).toBe('error');
    expect(state.error?.code).toBe('VOICE_SESSION_BUSY');
    // 引导文案：告诉用户通话在另一个窗口、给出下一步；不再是「已有一路通话在进行中」
    const copy = voiceZh.voice.messageByCode.VOICE_SESSION_BUSY;
    expect(copy).toContain('另一个窗口');
    expect(copy).not.toBe('已有一路通话在进行中');
  });

  it('回归门：到过 live 之后，B 档 code 不再收回 chrome（中途断线路径不变）', async () => {
    const socket = await dialAndOpen();
    socket.simulateEvent({ type: 'state', state: 'live' });

    socket.simulateEvent({ type: 'error', code: 'UPSTREAM_ERROR', message: 'upstream 500' });

    expect(useVoiceCallStore.getState().phase).toBe('error');
    expect(useVoiceCallStore.getState().error?.code).toBe('UPSTREAM_ERROR');
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('回归门：到过 live 之后的网络抖动仍走重连退避', async () => {
    const socket = await dialAndOpen();
    socket.simulateEvent({ type: 'state', state: 'live' });
    vi.useFakeTimers();

    socket.simulateClose(1006);
    expect(useVoiceCallStore.getState().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets).toHaveLength(2);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
