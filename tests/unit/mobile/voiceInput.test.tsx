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

  it('records a retry failure instead of swallowing it', async () => {
    let attempt = 0;
    mount({ transcribe: async () => { attempt += 1; throw new Error(attempt === 1 ? 'FIRST' : 'RETRY_FAILED'); } });
    clickMic();
    fireEvent.click(await screen.findByRole('button', { name: text.stopRecording }));
    fireEvent.click(await screen.findByRole('button', { name: text.retry }));
    await waitFor(() => expect(screen.getByText(`${text.voiceTranscribeFailed} · RETRY_FAILED`)).toBeTruthy());
  });
});
