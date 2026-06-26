import * as path from 'path';
import type { ToolContext } from '../../protocol/tools';
import { executeLocalSpeechToText } from '../../tools/modules/network/localSpeechToText';
import { createLogger } from '../infra/logger';

const logger = createLogger('AudioTranscriptionService');

export interface AudioTranscriptionOptions {
  filePath: string;
  sessionId?: string;
  language?: string;
  abortSignal?: AbortSignal;
}

export interface AudioTranscriptionResult {
  ok: boolean;
  text?: string;
  engine?: string;
  error?: string;
  code?: string;
}

export async function transcribeAudioFile(
  options: AudioTranscriptionOptions,
): Promise<AudioTranscriptionResult> {
  const abortController = options.abortSignal ? null : new AbortController();
  const signal = options.abortSignal ?? abortController!.signal;
  const ctx: ToolContext = {
    sessionId: options.sessionId ?? 'channel-media',
    workingDir: path.dirname(options.filePath),
    abortSignal: signal,
    logger,
    emit: () => {},
  };

  const result = await executeLocalSpeechToText(
    {
      file_path: options.filePath,
      language: options.language ?? 'zh',
      output_format: 'text',
    },
    ctx,
    async () => ({ allow: true }),
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      code: result.code,
    };
  }

  const meta = result.meta as Record<string, unknown> | undefined;
  return {
    ok: true,
    text: result.output,
    engine: typeof meta?.model === 'string' ? meta.model : 'whisper-cpp',
  };
}
