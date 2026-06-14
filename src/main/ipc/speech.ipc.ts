// ============================================================================
// Speech IPC - desktop voice input transcription handlers
// ============================================================================

import type { IpcMain } from '../platform';
import {
  type SpeechRetainedAudioClearResult,
  type SpeechTranscribeOptions,
  type SpeechTranscribeResult,
} from '../../shared/contract/speech';
import { createLogger } from '../services/infra/logger';
import {
  clearRetainedSpeechAudio,
  getSpeechTranscriptionService,
} from '../services/speech/speechTranscriptionService';
import { summarizeUserFacingError } from '../security/userFacingError';

const logger = createLogger('Speech');

export const SPEECH_CHANNELS = {
  TRANSCRIBE: 'speech:transcribe',
  CLEAR_RETAINED_AUDIO: 'speech:clear-retained-audio',
} as const;

export interface TranscribeRequest extends SpeechTranscribeOptions {
  audioData: string;
  mimeType: string;
}

export type TranscribeResponse = SpeechTranscribeResult;

export function registerSpeechHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    SPEECH_CHANNELS.TRANSCRIBE,
    async (_event, request: TranscribeRequest): Promise<TranscribeResponse> => {
      try {
        return await getSpeechTranscriptionService().transcribe({
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
    async (): Promise<SpeechRetainedAudioClearResult> => clearRetainedSpeechAudio(),
  );

  logger.info('Speech handlers registered');
}
