import * as fs from 'fs';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import { MODEL_API_ENDPOINTS, ZHIPU_VISION_MODEL } from '../../../shared/constants';

const logger = createLogger('VisionAnalysisService');

const DEFAULT_TIMEOUT_MS = 30_000;

export type VisionAnalysisFailureReason =
  | 'missing_api_key'
  | 'http_error'
  | 'timeout'
  | 'exception'
  | 'empty_response';

export type VisionAnalysisResult =
  | {
    ok: true;
    analysis: string;
    model: string;
  }
  | {
    ok: false;
    analysis: null;
    reason: VisionAnalysisFailureReason;
    error: string;
    model: string;
    httpStatus?: number;
    retryable: boolean;
  };

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeHttpError(status: number, body: string): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return `Vision analysis request failed with HTTP ${status}`;
  }
  return `Vision analysis request failed with HTTP ${status}: ${trimmedBody}`;
}

export async function analyzeImageWithVisionDetailed(args: {
  imagePath: string;
  prompt: string;
  source: string;
  timeoutMs?: number;
}): Promise<VisionAnalysisResult> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');

  if (!zhipuApiKey) {
    logger.info('Vision analysis skipped: zhipu API key is not configured', { source: args.source });
    return {
      ok: false,
      analysis: null,
      reason: 'missing_api_key',
      error: 'Zhipu API key is not configured',
      model: ZHIPU_VISION_MODEL,
      retryable: false,
    };
  }

  try {
    const imageData = fs.readFileSync(args.imagePath);
    const base64Image = imageData.toString('base64');

    const response = await fetchWithTimeout(
      `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${zhipuApiKey}`,
        },
        body: JSON.stringify({
          model: ZHIPU_VISION_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: args.prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 2048,
        }),
      },
      args.timeoutMs || DEFAULT_TIMEOUT_MS,
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn('Vision analysis request failed', {
        source: args.source,
        status: response.status,
        error: errorText,
      });
      return {
        ok: false,
        analysis: null,
        reason: 'http_error',
        error: normalizeHttpError(response.status, errorText),
        model: ZHIPU_VISION_MODEL,
        httpStatus: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      };
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (content) {
      logger.info('Vision analysis completed', {
        source: args.source,
        contentLength: content.length,
      });
    }

    if (!content) {
      logger.warn('Vision analysis returned empty content', {
        source: args.source,
      });
      return {
        ok: false,
        analysis: null,
        reason: 'empty_response',
        error: 'Vision analysis returned empty content',
        model: ZHIPU_VISION_MODEL,
        retryable: true,
      };
    }

    return {
      ok: true,
      analysis: content,
      model: ZHIPU_VISION_MODEL,
    };
  } catch (error: unknown) {
    const aborted = isAbortError(error);
    logger.warn(aborted ? 'Vision analysis timed out' : 'Vision analysis failed', {
      source: args.source,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      analysis: null,
      reason: aborted ? 'timeout' : 'exception',
      error: aborted
        ? `Vision analysis timed out after ${args.timeoutMs || DEFAULT_TIMEOUT_MS}ms`
        : `Vision analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      model: ZHIPU_VISION_MODEL,
      retryable: true,
    };
  }
}

export async function analyzeImageWithVision(args: {
  imagePath: string;
  prompt: string;
  source: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const result = await analyzeImageWithVisionDetailed(args);
  return result.ok ? result.analysis : null;
}
