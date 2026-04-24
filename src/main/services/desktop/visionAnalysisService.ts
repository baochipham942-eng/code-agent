import * as fs from 'fs';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import { MODEL_API_ENDPOINTS, ZHIPU_VISION_MODEL } from '../../../shared/constants';

const logger = createLogger('VisionAnalysisService');

const DEFAULT_TIMEOUT_MS = 30_000;

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

export async function analyzeImageWithVision(args: {
  imagePath: string;
  prompt: string;
  source: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');

  if (!zhipuApiKey) {
    logger.info('Vision analysis skipped: zhipu API key is not configured', { source: args.source });
    return null;
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
      return null;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (content) {
      logger.info('Vision analysis completed', {
        source: args.source,
        contentLength: content.length,
      });
    }

    return content || null;
  } catch (error: unknown) {
    logger.warn('Vision analysis failed', {
      source: args.source,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
