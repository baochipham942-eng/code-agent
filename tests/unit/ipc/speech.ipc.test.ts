import { describe, expect, it, vi } from 'vitest';
import {
  registerSpeechHandlers,
  SPEECH_CHANNELS,
} from '../../../src/host/ipc/speech.ipc';

describe('speech capability IPC contribution', () => {
  it('removes every package-owned handler during cleanup', async () => {
    const handle = vi.fn();
    const removeHandler = vi.fn();

    const cleanup = registerSpeechHandlers({ handle, removeHandler } as never);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      SPEECH_CHANNELS.TRANSCRIBE,
      SPEECH_CHANNELS.CLEAR_RETAINED_AUDIO,
    ]);
    await cleanup();
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      SPEECH_CHANNELS.TRANSCRIBE,
      SPEECH_CHANNELS.CLEAR_RETAINED_AUDIO,
    ]);
  });
});
