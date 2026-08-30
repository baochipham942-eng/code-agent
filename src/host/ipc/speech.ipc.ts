// ============================================================================
// Speech IPC - desktop voice input transcription handlers
// ============================================================================

import type { IpcMain } from '../platform';
import type { HostCapabilityCleanup } from '../services/capabilities/hostCapabilityPorts';
import {
  type SpeechRetainedAudioClearResult,
  type SpeechTranscribeOptions,
  type SpeechTranscribeResult,
} from '../../shared/contract/speech';
import { createLogger } from '../services/infra/logger';
import { summarizeUserFacingError } from '../security/userFacingError';

const logger = createLogger('Speech');
interface SpeechTranscriptionRequest extends SpeechTranscribeOptions {
  audioBuffer?: Buffer;
  audioData?: string;
  mimeType: string;
}
type SpeechTranscriber = (request: SpeechTranscriptionRequest) => Promise<SpeechTranscribeResult>;
let transcribe: SpeechTranscriber | null = null;
let clearRetainedAudio: (() => SpeechRetainedAudioClearResult) | null = null;

export function configureSpeechHandlers(deps: {
  transcribe: SpeechTranscriber;
  clearRetainedAudio: () => SpeechRetainedAudioClearResult;
}): HostCapabilityCleanup {
  transcribe = deps.transcribe;
  clearRetainedAudio = deps.clearRetainedAudio;
  return () => {
    if (transcribe === deps.transcribe) transcribe = null;
    if (clearRetainedAudio === deps.clearRetainedAudio) clearRetainedAudio = null;
  };
}

export const SPEECH_CHANNELS = {
  TRANSCRIBE: 'speech:transcribe',
  CLEAR_RETAINED_AUDIO: 'speech:clear-retained-audio',
} as const;

export interface TranscribeRequest extends SpeechTranscribeOptions {
  audioData: string;
  mimeType: string;
}

export type TranscribeResponse = SpeechTranscribeResult;

export function registerSpeechHandlers(ipcMain: IpcMain): HostCapabilityCleanup {
  ipcMain.handle(
    SPEECH_CHANNELS.TRANSCRIBE,
    async (_event, request: TranscribeRequest): Promise<TranscribeResponse> => {
      try {
        if (!transcribe) throw new Error('voice-input capability is not installed');
        return await transcribe({
          ...request,
          source: request.source || 'composer',
        });
      } catch (error) {
        const { summary } = summarizeUserFacingError(error, { surface: 'renderer_toast' });
        logger.error('Speech transcription handler failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: summary || (error instanceof Error ? error.message : '转写失败'),
          code: 'TRANSCRIPTION_FAILED',
          recoverable: true,
        };
      }
    },
  );

  ipcMain.handle(
    SPEECH_CHANNELS.CLEAR_RETAINED_AUDIO,
    async (): Promise<SpeechRetainedAudioClearResult> => {
      if (!clearRetainedAudio) throw new Error('voice-input capability is not installed');
      return clearRetainedAudio();
    },
  );

  logger.info('Speech handlers registered');
  return () => {
    ipcMain.removeHandler(SPEECH_CHANNELS.TRANSCRIBE);
    ipcMain.removeHandler(SPEECH_CHANNELS.CLEAR_RETAINED_AUDIO);
  };
}
