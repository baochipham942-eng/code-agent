// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: true,
  pipelines: [] as Array<{
    stop: ReturnType<typeof vi.fn>;
    setMuted: ReturnType<typeof vi.fn>;
    setCaptureOpen: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(async () => ({
      voice: {
        inputDevice: { label: 'Studio Mic', webDeviceId: 'studio-1' },
        live: { interrupt: 'server_vad', echoCancellation: 'off' },
      },
    })),
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
  readPreferredVoiceInputAvailability: vi.fn(async () => mocks.available),
  VoiceAudioPipeline: class {
    stop = vi.fn();
    setMuted = vi.fn();
    setCaptureOpen = vi.fn();
    constructor() {
      mocks.pipelines.push(this);
    }
    async start() {}
    enqueuePlayback() {}
    clearPlayback() {}
    getMicLevel() { return 0; }
  },
}));

const { voiceCallBridge } = await import('../../../src/renderer/services/voiceCallBridge');
const { useVoiceCallStore } = await import('../../../src/renderer/stores/voiceCallStore');

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() { this.readyState = 3; }
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

let socket: FakeWebSocket;
let deviceChange: (() => void) | null;

describe('voiceCallBridge 通话中输入设备恢复', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.available = true;
    mocks.pipelines.length = 0;
    FakeWebSocket.instances.length = 0;
    deviceChange = null;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        addEventListener: vi.fn((_type: string, listener: () => void) => {
          deviceChange = listener;
        }),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    useVoiceCallStore.getState().reset();
    await voiceCallBridge.dial('session-device-restore');
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.simulateOpen();
    await vi.waitFor(() => expect(deviceChange).not.toBeNull());
    await vi.waitFor(() => expect(mocks.pipelines).toHaveLength(1));
  });

  afterEach(() => {
    voiceCallBridge.hangUp();
    vi.unstubAllGlobals();
    useVoiceCallStore.getState().reset();
  });

  it('拔出后回默认，恢复后再自动切回，且不重建 WebSocket', async () => {
    mocks.available = false;
    deviceChange?.();
    await vi.waitFor(() => expect(mocks.pipelines).toHaveLength(2));
    expect(mocks.pipelines[0].stop).toHaveBeenCalled();

    mocks.available = true;
    deviceChange?.();
    await vi.waitFor(() => expect(mocks.pipelines).toHaveLength(3));
    expect(mocks.pipelines[1].stop).toHaveBeenCalled();
    expect(mocks.pipelines[2].setCaptureOpen).toHaveBeenLastCalledWith(true);
  });

  it('旧通话的 devicechange 回调不会重启新通话的采集管线', async () => {
    const staleDeviceChange = deviceChange;
    voiceCallBridge.hangUp();

    await voiceCallBridge.dial('session-device-restore-next');
    expect(FakeWebSocket.instances).toHaveLength(2);
    socket = FakeWebSocket.instances[1] as FakeWebSocket;
    socket.simulateOpen();
    await vi.waitFor(() => expect(mocks.pipelines).toHaveLength(2));
    await vi.waitFor(() => expect(deviceChange).not.toBe(staleDeviceChange));

    mocks.available = false;
    staleDeviceChange?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.pipelines).toHaveLength(2);
  });
});
