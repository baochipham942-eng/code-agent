// @vitest-environment jsdom
// useVoiceInput：MediaRecorder 录音 → IPC ASR 转写的较重媒体 hook。
// stub navigator.mediaDevices.getUserMedia / window.MediaRecorder / AudioContext，
// mock ipcService（settings 加载 + transcribeSpeech）。覆盖支持检测 / 权限错误 /
// 录音→onstop→转写成功失败 / 太短 / retry / toggle / clearError / 设置事件更新。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SpeechTranscribeResult } from '../../../src/shared/contract/speech';

const ipc = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  invokeDomain: vi.fn(async (..._args: unknown[]) => ({ speech: {} })),
  transcribeSpeech: vi.fn(async (..._args: unknown[]): Promise<SpeechTranscribeResult | null> => ({ success: true, text: '你好世界' })),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => ipc.isAvailable(),
    invokeDomain: (...a: unknown[]) => ipc.invokeDomain(...a),
    transcribeSpeech: (...a: unknown[]) => ipc.transcribeSpeech(...a),
  },
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { useVoiceInput } from '../../../src/renderer/hooks/useVoiceInput';

// --- 媒体 stub ---
let lastRecorder: FakeMediaRecorder | null = null;
let getUserMediaImpl: () => Promise<MediaStream>;

class FakeMediaRecorder {
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public stream: MediaStream, public opts: { mimeType: string }) {}
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
}

// 工厂包装：捕获最近创建的实例（避免在构造器里 alias this 触发 eslint no-this-alias）
function makeMediaRecorder(stream: MediaStream, opts: { mimeType: string }) {
  const recorder = new FakeMediaRecorder(stream, opts);
  lastRecorder = recorder;
  return recorder;
}
makeMediaRecorder.isTypeSupported = () => true;

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

function installMedia() {
  // jsdom 的 Blob 不实现 arrayBuffer()，转写链路需要它
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return Promise.resolve(new ArrayBuffer(8));
    };
  }
  getUserMediaImpl = () => Promise.resolve(fakeStream());
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getUserMedia: () => getUserMediaImpl(),
  };
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = makeMediaRecorder;
  // AudioContext stub（level meter）
  (window as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running';
    createAnalyser() {
      return { fftSize: 0, smoothingTimeConstant: 0, getByteTimeDomainData: () => {} };
    }
    createMediaStreamSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    close() {
      return Promise.resolve();
    }
  };
}

// 用 Date.now spy 控制时间（不能用 fake timers——会和 RTL waitFor 的定时器轮询死锁）
let nowVal = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  nowVal = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => nowVal);
  ipc.isAvailable.mockReturnValue(true);
  ipc.invokeDomain.mockResolvedValue({ speech: { enabled: true } });
  ipc.transcribeSpeech.mockResolvedValue({ success: true, text: '你好世界' });
  lastRecorder = null;
  installMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 完整录音 → 停止 → 转写 的驱动器
async function recordAndStop(view: { result: { current: { start: () => void } } }, elapsedMs = 2000) {
  await act(async () => {
    await view.result.current.start();
  });
  // 模拟收到音频块
  act(() => {
    lastRecorder!.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
  });
  // 推进时间让 finalDuration >= 1
  nowVal = 1_000_000 + elapsedMs;
  await act(async () => {
    await lastRecorder!.onstop?.();
  });
}

describe('支持检测与前置校验', () => {
  it('设置关闭 → DISABLED', async () => {
    ipc.invokeDomain.mockResolvedValue({ speech: { enabled: false } });
    const { result } = renderHook(() => useVoiceInput());
    await waitFor(() => expect(result.current.isEnabled).toBe(false));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.errorCode).toBe('DISABLED');
  });

  it('MediaRecorder 不存在 → UNSUPPORTED', async () => {
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    const { result } = renderHook(() => useVoiceInput());
    await waitFor(() => expect(result.current.isEnabled).toBe(true));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.errorCode).toBe('UNSUPPORTED');
    expect(result.current.isSupported).toBe(false);
    // Codex 审计：unsupported 分支应与 DISABLED 分支对称设 status='error'，
    // 否则 UI 停在 idle 却持有错误（曾经的生产不一致，本 PR 一并修复）
    expect(result.current.status).toBe('error');
  });
});

describe('麦克风权限错误', () => {
  it('NotAllowedError → MICROPHONE_PERMISSION_DENIED', async () => {
    getUserMediaImpl = () => {
      const e = new Error('denied');
      e.name = 'NotAllowedError';
      return Promise.reject(e);
    };
    const { result } = renderHook(() => useVoiceInput());
    await waitFor(() => expect(result.current.isEnabled).toBe(true));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.errorCode).toBe('MICROPHONE_PERMISSION_DENIED');
  });

  it('其他错误 → MICROPHONE_UNAVAILABLE', async () => {
    getUserMediaImpl = () => Promise.reject(new Error('busy'));
    const { result } = renderHook(() => useVoiceInput());
    await waitFor(() => expect(result.current.isEnabled).toBe(true));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.errorCode).toBe('MICROPHONE_UNAVAILABLE');
  });
});

describe('录音 → 转写主链路', () => {
  it('成功转写 → 回调 onTranscript，状态回 idle', async () => {
    const onTranscript = vi.fn();
    const view = renderHook(() => useVoiceInput({ onTranscript }));
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await recordAndStop(view);
    // Codex 审计：断言 ASR 选项被透传——source='composer' 与 durationSeconds 是 load-bearing，
    // 丢了会让计费/上下文归属错乱却仍绿
    expect(ipc.transcribeSpeech).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ source: 'composer', durationSeconds: 2, mode: expect.anything(), language: expect.anything() }),
    );
    expect(onTranscript).toHaveBeenCalledWith('你好世界', expect.objectContaining({ success: true }));
    expect(view.result.current.status).toBe('idle');
  });

  it('录音太短（<1s）→ AUDIO_TOO_SHORT', async () => {
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await act(async () => {
      await view.result.current.start();
    });
    act(() => {
      lastRecorder!.ondataavailable?.({ data: new Blob(['a'], { type: 'audio/webm' }) });
    });
    // 不推进时间 → finalDuration 0
    await act(async () => {
      await lastRecorder!.onstop?.();
    });
    expect(view.result.current.errorCode).toBe('AUDIO_TOO_SHORT');
  });

  it('转写返回 success=false → error 状态', async () => {
    ipc.transcribeSpeech.mockResolvedValue({ success: false, error: 'ASR 挂了', code: 'ASR_FAIL' });
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await recordAndStop(view);
    expect(view.result.current.status).toBe('error');
    expect(view.result.current.error).toContain('ASR 挂了');
  });

  it('转写服务不可用（返回 null）→ error', async () => {
    ipc.transcribeSpeech.mockResolvedValue(null);
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await recordAndStop(view);
    expect(view.result.current.status).toBe('error');
  });
});

describe('stop / toggle / retry / clearError', () => {
  it('stop 在录音中触发 recorder.stop', async () => {
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await act(async () => {
      await view.result.current.start();
    });
    const stopSpy = vi.spyOn(lastRecorder!, 'stop');
    act(() => view.result.current.stop());
    expect(stopSpy).toHaveBeenCalled();
  });

  it('retry 复用 pendingAudio 重新转写（失败后可重试）', async () => {
    ipc.transcribeSpeech.mockResolvedValueOnce({ success: false, error: 'x', recoverable: true });
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await recordAndStop(view);
    expect(view.result.current.status).toBe('error');
    expect(view.result.current.canRetry).toBe(true);
    ipc.transcribeSpeech.mockResolvedValueOnce({ success: true, text: '重试成功' });
    await act(async () => {
      view.result.current.retry();
    });
    await waitFor(() => expect(view.result.current.status).toBe('idle'));
  });

  it('前置门错误（unsupported）清掉残留 pendingAudio，canRetry 不误亮', async () => {
    // 先制造一次可重试失败 → pendingAudio 留存、canRetry 亮
    ipc.transcribeSpeech.mockResolvedValueOnce({ success: false, error: 'x', recoverable: true });
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await recordAndStop(view);
    expect(view.result.current.canRetry).toBe(true);
    // 再走 unsupported 前置门 → 应清掉残留，canRetry 归 false
    delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    await act(async () => {
      await view.result.current.start();
    });
    expect(view.result.current.errorCode).toBe('UNSUPPORTED');
    expect(view.result.current.canRetry).toBe(false);
  });

  it('前置门错误（disabled）同样清掉残留 pendingAudio，canRetry 不误亮', async () => {
    // 与 unsupported 分支对称：先制造可重试失败 → 再关闭语音输入再点开始
    ipc.transcribeSpeech.mockResolvedValueOnce({ success: false, error: 'x', recoverable: true });
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await recordAndStop(view);
    expect(view.result.current.canRetry).toBe(true);
    // 设置事件关闭语音输入 → 走 DISABLED 前置门
    act(() => {
      window.dispatchEvent(new CustomEvent('voice-input-settings-updated', { detail: { enabled: false } }));
    });
    await act(async () => {
      await view.result.current.start();
    });
    expect(view.result.current.errorCode).toBe('DISABLED');
    expect(view.result.current.canRetry).toBe(false);
  });

  it('clearError 复位状态', async () => {
    getUserMediaImpl = () => Promise.reject(new Error('busy'));
    const view = renderHook(() => useVoiceInput());
    await waitFor(() => expect(view.result.current.isEnabled).toBe(true));
    await act(async () => {
      await view.result.current.start();
    });
    expect(view.result.current.status).toBe('error');
    act(() => view.result.current.clearError());
    expect(view.result.current.status).toBe('idle');
    expect(view.result.current.error).toBeNull();
  });
});

describe('设置加载与事件更新', () => {
  it('挂载从 IPC 拉取 speech 设置', async () => {
    renderHook(() => useVoiceInput());
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(expect.anything(), 'get'));
  });

  it('VOICE_INPUT_SETTINGS_UPDATED_EVENT 更新设置', async () => {
    const { result } = renderHook(() => useVoiceInput());
    await waitFor(() => expect(result.current.isEnabled).toBe(true));
    act(() => {
      window.dispatchEvent(new CustomEvent('voice-input-settings-updated', { detail: { enabled: false } }));
    });
    expect(result.current.isEnabled).toBe(false);
  });
});
