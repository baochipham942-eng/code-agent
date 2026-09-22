// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../../../packages/mobile/src/features/sessions/Composer';
import { messages } from '../../../packages/mobile/src/i18n';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';
import { GUMMY_REALTIME_SAMPLE_RATE } from '../../../src/shared/constants/voice';
import type { CompanionDictationEvent, CompanionDictationOpenResult } from '../../../src/shared/contract/companionDictation';
import type { CompanionTranscriptionReadiness } from '../../../src/shared/companion/lanProtocol';
import type { DictationPort } from '../../../packages/mobile/src/features/sessions/VoiceCapture';

const text = messages('zh');

const advance = async (ms: number, step = 50) => {
  for (let passed = 0; passed < ms; passed += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(step); });
  }
};

function RealtimeHarness({
  dictation,
  pcm,
  commit,
  transcribe,
  available = true,
  stopPcm,
  startPcm,
  start,
  transcription,
  dictationTranscription,
}: {
  dictation: {
    open: () => Promise<CompanionDictationOpenResult>;
    audio: (streamId: string, pcm: string) => Promise<{ ok: boolean; events: CompanionDictationEvent[] }>;
    stop: (streamId: string) => Promise<{ ok: boolean; events: CompanionDictationEvent[] }>;
    close: () => Promise<void>;
  };
  pcm?: (emit: (frame: { pcm: string; durationMs: number }) => void) => void;
  commit?: (text: string, continuation: boolean) => void;
  transcribe?: () => Promise<string | null>;
  available?: boolean;
  stopPcm?: () => Promise<void>;
  startPcm?: () => Promise<{ sampleRate: number }>;
  start?: () => Promise<void>;
  /** 分段转写（Groq）三态：'no-key' 时预检要看实时听写这条路。 */
  transcription?: CompanionTranscriptionReadiness;
  dictationTranscription?: CompanionTranscriptionReadiness;
}) {
  const [draft, setDraft] = React.useState('');
  const listeners = React.useRef<Array<(frame: { pcm: string; durationMs: number }) => void>>([]);
  const recorder = React.useRef({
    start: start ?? (async () => {}),
    stop: async () => ({ audioData: 'chunk1', mimeType: 'audio/aac' as const, durationMs: 4000 }),
    startPcm: startPcm ?? (async () => ({ sampleRate: COMPANION_LIMITS.voicePcmSampleRate })),
    stopPcm: async () => { await stopPcm?.(); },
    subscribePcm: (onFrame: (frame: { pcm: string; durationMs: number }) => void) => {
      listeners.current.push(onFrame);
      pcm?.(frame => listeners.current.forEach(listener => listener(frame)));
      return () => { listeners.current = listeners.current.filter(listener => listener !== onFrame); };
    },
  }).current;
  const port: DictationPort = {
    available,
    open: dictation.open,
    audio: dictation.audio,
    stop: dictation.stop,
    close: dictation.close,
  };
  return <Composer text={text} draft={draft} editDraft={setDraft} offline={false} sendDisabled={!draft} send={() => {}}
    modelLabel="DeepSeek V4.1 Flash" openModel={() => {}} attach={() => {}} attachDisabled={false}
    recorder={recorder}
    transcribe={async () => transcribe ? transcribe() : null}
    discardPendingTranscript={() => {}}
    commitSpoken={async (spoken, continuation) => {
      commit?.(spoken, continuation);
      setDraft(previous => previous ? `${previous}${spoken}` : spoken);
    }}
    dictation={port}
    transcription={transcription}
    dictationTranscription={dictationTranscription}
    voiceReady voiceDisabled={false} voicePending={false} voiceResult={null} onVoiceState={() => {}} />;
}

describe('realtime dictation', () => {
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('pins the phone PCM rate to Gummy so a drift degrades instead of sending the wrong clock', () => {
    expect(COMPANION_LIMITS.voicePcmSampleRate).toBe(GUMMY_REALTIME_SAMPLE_RATE);
  });

  it('does not open a dictation stream against a host that never advertised it', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => ({ ok: true as const, streamId: 's', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }));
    const transcribe = vi.fn(async () => 'cmd-1');
    render(<RealtimeHarness
      available={false}
      dictation={{ open, audio: async () => ({ ok: true, events: [] }), stop: async () => ({ ok: true, events: [] }), close: async () => {} }}
      transcribe={transcribe}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(5_000);
    expect(open).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalled();
  });

  // N-MOBILE-VOICE-TRANSCRIBE-FIX-R6 ai-review Important：两条转写路各用各的密钥——
  // 只配百炼（分段 no-key、实时听写 ready）的电脑，手机实时听写不能被 Groq 的三态拦死。
  it('只配百炼（transcription=no-key、dictationTranscription=ready）：点麦克风不拦，直接开实时听写', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }));
    const transcribe = vi.fn(async () => 'cmd-1');
    render(<RealtimeHarness
      transcription="no-key" dictationTranscription="ready"
      dictation={{ open, audio: async () => ({ ok: true, events: [] }), stop: async () => ({ ok: true, events: [] }), close: async () => {} }}
      transcribe={transcribe}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(200);
    expect(open).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: text.stopRecording })).toBeTruthy();
    // 不出「电脑上还没开语音转写」——那条指引会让只配百炼的用户去填错密钥
    expect(document.querySelector('[data-testid="status-slot"]')).toBeNull();
  });

  it('旧宿主不报 dictationTranscription：分段 no-key 也不拦实时听写（旧行为不破）', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }));
    render(<RealtimeHarness
      transcription="no-key"
      dictation={{ open, audio: async () => ({ ok: true, events: [] }), stop: async () => ({ ok: true, events: [] }), close: async () => {} }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(200);
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: text.stopRecording })).toBeTruthy();
    expect(document.querySelector('[data-testid="status-slot"]')).toBeNull();
  });

  it('宿主广告了听写但没配百炼（dictationTranscription=no-key）且分段也没密钥 → 仍拦', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }));
    const start = vi.fn(async () => {});
    render(<RealtimeHarness
      transcription="no-key" dictationTranscription="no-key" start={start}
      dictation={{ open, audio: async () => ({ ok: true, events: [] }), stop: async () => ({ ok: true, events: [] }), close: async () => {} }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(50);
    expect(document.querySelector('[data-testid="status-slot"][data-rank="4"]')?.textContent).toContain('电脑上还没开语音转写');
    expect(open).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('shows partials as they arrive and replaces them instead of appending', async () => {
    vi.useFakeTimers();
    const audio = vi.fn(async (_streamId: string, _pcm: string) => ({
      ok: true,
      events: [
        { type: 'partial' as const, text: '你', sentenceId: 1 },
        { type: 'partial' as const, text: '你好', sentenceId: 1 },
      ],
    }));
    let emit: ((frame: { pcm: string; durationMs: number }) => void) | undefined;
    render(<RealtimeHarness
      pcm={next => { emit = next; }}
      dictation={{
        open: async () => ({ ok: true, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }),
        audio,
        stop: async () => ({ ok: true, events: [{ type: 'final', text: '你好。', sentenceId: 1 }] }),
        close: async () => {},
      }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(20);
    await act(async () => { emit?.({ pcm: 'AAEA', durationMs: 20 }); });
    await advance(50);
    expect(document.querySelector('.transcription')?.textContent).toBe('你好');
    expect(document.querySelector('.transcription')?.textContent).not.toContain('你你好');
  });

  it('degrades to chunked when the stream errors, keeps already-spoken text, and says so', async () => {
    vi.useFakeTimers();
    const transcribe = vi.fn(async () => 'cmd-1');
    const commit = vi.fn();
    const close = vi.fn(async () => {});
    let emit: ((frame: { pcm: string; durationMs: number }) => void) | undefined;
    render(<RealtimeHarness
      pcm={next => { emit = next; }}
      transcribe={transcribe}
      commit={commit}
      dictation={{
        open: async () => ({ ok: true, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }),
        audio: async () => ({
          ok: true,
          events: [
            { type: 'final', text: '已经说了', sentenceId: 1 },
            { type: 'error', code: 'SPEECH_NO_CHANNEL', message: 'drop' },
          ],
        }),
        stop: async () => ({ ok: true, events: [] }),
        close,
      }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(20);
    await act(async () => { emit?.({ pcm: 'AAEA', durationMs: 20 }); });
    await advance(200);
    expect(commit).toHaveBeenCalledWith('已经说了', false);
    expect(close).toHaveBeenCalled();
    expect(screen.getByText(text.voiceDegraded)).toBeTruthy();
    await advance(5_000);
    expect(transcribe).toHaveBeenCalled();
  });

  it('cancel on the realtime path stops the PCM engine so the next take can start', async () => {
    vi.useFakeTimers();
    const stopPcm = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    let resolveOpen: ((value: CompanionDictationOpenResult) => void) | undefined;
    render(<RealtimeHarness
      stopPcm={stopPcm}
      dictation={{
        open: () => new Promise(resolve => { resolveOpen = resolve; }),
        audio: async () => ({ ok: true, events: [] }),
        stop: async () => ({ ok: true, events: [] }),
        close,
      }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(20);
    fireEvent.click(screen.getByRole('button', { name: text.cancelRecording }));
    await advance(20);
    expect(stopPcm).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    resolveOpen?.({ ok: true, streamId: 'late', sampleRate: COMPANION_LIMITS.voicePcmSampleRate });
  });

  it('keeps PCM frames that arrive while dictation.open is still in flight', async () => {
    vi.useFakeTimers();
    const audio = vi.fn(async () => ({ ok: true, events: [] as CompanionDictationEvent[] }));
    let resolveOpen: ((value: CompanionDictationOpenResult) => void) | undefined;
    let emit: ((frame: { pcm: string; durationMs: number }) => void) | undefined;
    render(<RealtimeHarness
      pcm={next => { emit = next; }}
      dictation={{
        open: () => new Promise(resolve => { resolveOpen = resolve; }),
        audio,
        stop: async () => ({ ok: true, events: [] }),
        close: async () => {},
      }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(20);
    await act(async () => { emit?.({ pcm: 'AAEA', durationMs: 20 }); });
    expect(audio).not.toHaveBeenCalled();
    await act(async () => {
      resolveOpen?.({ ok: true, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate });
    });
    await advance(50);
    expect(audio).toHaveBeenCalledWith('stream-1', 'AAEA');
  });

  it('commits a leftover partial when the user stops and Host never sends a final', async () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    let emit: ((frame: { pcm: string; durationMs: number }) => void) | undefined;
    render(<RealtimeHarness
      pcm={next => { emit = next; }}
      commit={commit}
      dictation={{
        open: async () => ({ ok: true, streamId: 'stream-1', sampleRate: COMPANION_LIMITS.voicePcmSampleRate }),
        audio: async () => ({ ok: true, events: [{ type: 'partial', text: '还没定稿', sentenceId: 1 }] }),
        stop: async () => ({ ok: true, events: [] }),
        close: async () => {},
      }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(20);
    await act(async () => { emit?.({ pcm: 'AAEA', durationMs: 20 }); });
    await advance(50);
    fireEvent.click(screen.getByRole('button', { name: text.stopRecording }));
    await advance(50);
    expect(commit).toHaveBeenCalledWith('还没定稿', false);
    expect((screen.getByTestId('draft') as HTMLTextAreaElement).value).toContain('还没定稿');
  });

  it('degrades at open when Host has no channel, without calling transcribe as dictation', async () => {
    vi.useFakeTimers();
    const transcribe = vi.fn(async () => 'cmd-1');
    const audio = vi.fn(async () => ({ ok: true, events: [] as CompanionDictationEvent[] }));
    render(<RealtimeHarness
      transcribe={transcribe}
      dictation={{
        open: async () => ({ ok: false, code: 'SPEECH_NO_CHANNEL' }),
        audio,
        stop: async () => ({ ok: true, events: [] }),
        close: async () => {},
      }}
    />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    await advance(20);
    expect(screen.getByText(text.voiceDegraded)).toBeTruthy();
    expect(audio).not.toHaveBeenCalled();
    await advance(5_000);
    expect(transcribe).toHaveBeenCalled();
  });
});

describe('麦克风被通话占着（N-MOBILE-VOICE-ERRCODE-LEAK）', () => {
  afterEach(cleanup);

  // build 45 真机：实时路径起录报占用 → 退回分段录音再起一次 → 真因被换成 FAILED_TO_RECORD。
  it('实时起录报 MICROPHONE_BUSY 就地报占用，不退分段再撞一次', async () => {
    const start = vi.fn(async () => { throw new Error('FAILED_TO_RECORD'); });
    render(<RealtimeHarness start={start}
      startPcm={async () => { throw new Error('MICROPHONE_BUSY'); }}
      dictation={{ open: async () => ({ ok: false, code: 'UNUSED' }), audio: async () => ({ ok: true, events: [] }), stop: async () => ({ ok: true, events: [] }), close: async () => {} }} />);
    fireEvent.click(screen.getByRole('button', { name: text.voice }));
    const notice = await screen.findByText(new RegExp(text.microphoneBusy));
    expect(notice.closest('[data-testid="status-slot"]')!.getAttribute('data-reason')).toBe('MICROPHONE_BUSY');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('phone never holds a provider key', () => {
  it('mobile source has no DashScope/Groq endpoint or key material', () => {
    const root = path.join(process.cwd(), 'packages/mobile');
    const files = [
      'src/platform/capacitor.ts',
      'src/features/sessions/VoiceCapture.tsx',
      'src/stores/companionStore.ts',
      'src/app/MobileRoot.tsx',
      'ios-native/NeoVoiceRecorder.swift',
    ];
    const joined = files.map(file => readFileSync(path.join(root, file), 'utf8')).join('\n');
    expect(joined).not.toMatch(/dashscope\.aliyuncs\.com/i);
    expect(joined).not.toMatch(/gummy-realtime-v1/);
    expect(joined).not.toMatch(/api\.groq\.com/i);
    expect(joined).not.toMatch(/DASHSCOPE/i);
    expect(joined).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});
