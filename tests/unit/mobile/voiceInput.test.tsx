// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoiceInput } from '../../../packages/mobile/src/features/sessions/VoiceInput';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');

function mount(overrides: {
  start?: () => Promise<void>;
  stop?: () => Promise<{ audioData: string; mimeType: string; durationMs: number }>;
  transcribe?: (audio: { audioData: string; mimeType: string; durationMs: number }) => Promise<void>;
} = {}) {
  const recorder = {
    start: overrides.start ?? (async () => {}),
    stop: overrides.stop ?? (async () => ({ audioData: 'YXVkaW8=', mimeType: 'audio/aac', durationMs: 1000 })),
  };
  const transcribe = vi.fn(overrides.transcribe ?? (async () => {}));
  render(<VoiceInput recorder={recorder} text={text} disabled={false} pending={false} outcome={null} transcribe={transcribe} />);
  return { transcribe };
}

const clickMic = () => fireEvent.click(screen.getByRole('button', { name: text.voice }));

describe('VoiceInput failure reporting', () => {
  afterEach(cleanup);

  it('surfaces the real startRecording error code in the recording-stage copy', async () => {
    mount({ start: async () => { throw new Error('ALREADY_RECORDING'); } });
    clickMic();
    await waitFor(() => expect(screen.getByText(`${text.voiceRecordFailed} · ALREADY_RECORDING`)).toBeTruthy());
    // 录音阶段的失败绝不能显示成转写阶段的文案
    expect(screen.queryByText(new RegExp(text.voiceTranscribeFailed))).toBeNull();
  });

  it('reports a non-Error rejection instead of dropping it', async () => {
    mount({ start: async () => { throw 'PLUGIN_NOT_INITIALIZED'; } });
    clickMic();
    await waitFor(() => expect(screen.getByText(`${text.voiceRecordFailed} · PLUGIN_NOT_INITIALIZED`)).toBeTruthy());
  });

  it('keeps the dedicated permission copy without an error code', async () => {
    mount({ start: async () => { throw new Error('MICROPHONE_DENIED'); } });
    clickMic();
    await waitFor(() => expect(screen.getByText(text.microphoneDenied)).toBeTruthy());
  });

  it('separates a transcription failure from a recording failure', async () => {
    mount({ transcribe: async () => { throw new Error('COMPANION_CHANNEL_CLOSED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.stopRecording }));
    await waitFor(() => expect(screen.getByText(`${text.voiceTranscribeFailed} · COMPANION_CHANNEL_CLOSED`)).toBeTruthy());
    expect(screen.queryByText(new RegExp(text.voiceRecordFailed))).toBeNull();
  });

  it('stays quiet when a discarded recording fails to stop', async () => {
    // 切后台时原生侧会自己停录并删音频，之后这次 stop 抛 RECORDING_HAS_NOT_STARTED——
    // 录音本来就不要了，不该弹错误卡
    mount({ stop: async () => { throw new Error('RECORDING_HAS_NOT_STARTED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.cancelRecording }));
    await waitFor(() => expect(screen.getByRole('button', { name: text.voice })).toBeTruthy());
    expect(screen.queryByText(new RegExp(text.voiceRecordFailed))).toBeNull();
    expect(screen.queryByText(new RegExp('RECORDING_HAS_NOT_STARTED'))).toBeNull();
  });

  it('records a retry failure instead of swallowing it', async () => {
    let attempt = 0;
    mount({ transcribe: async () => { attempt += 1; throw new Error(attempt === 1 ? 'FIRST' : 'RETRY_FAILED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.stopRecording }));
    fireEvent.click(await screen.findByRole('button', { name: text.retry }));
    await waitFor(() => expect(screen.getByText(`${text.voiceTranscribeFailed} · RETRY_FAILED`)).toBeTruthy());
  });
});
