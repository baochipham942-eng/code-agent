import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import { MODEL_API_ENDPOINTS, ZHIPU_VISION_MODEL, VISION_IMAGE } from '../../../shared/constants';

const logger = createLogger('VisionAnalysisService');

const DEFAULT_TIMEOUT_MS = 30_000;

export type VisionAnalysisFailureReason =
  | 'missing_api_key'
  | 'http_error'
  | 'timeout'
  | 'exception'
  | 'empty_response';

/**
 * 分析图像的尺寸记账。
 * - original*: screencapture 出的物理像素尺寸（Retina 上是逻辑点的 scaleFactor 倍）
 * - analyzed*: 实际发给视觉模型的图像像素尺寸（降采样后，从输出文件回读）
 * 下游（坐标变换）靠这两组尺寸把模型返回的图像坐标换算回逻辑屏幕点。
 */
export type VisionImageDims = {
  originalWidth: number | null;
  originalHeight: number | null;
  analyzedWidth: number | null;
  analyzedHeight: number | null;
};

function emptyDims(): VisionImageDims {
  return {
    originalWidth: null,
    originalHeight: null,
    analyzedWidth: null,
    analyzedHeight: null,
  };
}

export type VisionAnalysisResult =
  | ({
    ok: true;
    analysis: string;
    model: string;
  } & VisionImageDims)
  | ({
    ok: false;
    analysis: null;
    reason: VisionAnalysisFailureReason;
    error: string;
    model: string;
    httpStatus?: number;
    retryable: boolean;
  } & VisionImageDims);

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

/**
 * 把截图准备成发给视觉模型的 base64：
 * 1. 用 sharp 读真实物理像素尺寸
 * 2. 按 scaleFactor 换算成逻辑点尺寸（让模型看到的图尽量贴近点空间，预先消化 DPI 问题）
 * 3. 超过 MAX_EDGE_PX 再等比降采样
 * 4. analyzedWidth/Height 从实际输出文件回读，不能用请求的目标值
 *
 * 降级保证：sharp 任何异常 → 回退发原始字节、dims 全 null，绝不硬失败。
 * 文件完全读不出来才抛错（交给调用方的 catch）。
 */
export async function prepareImageForVision(
  imagePath: string,
  scaleFactor: number,
): Promise<{ base64: string; dims: VisionImageDims; tempPath: string | null }> {
  try {
    const meta = await sharp(imagePath).metadata();
    const physW = meta.width ?? null;
    const physH = meta.height ?? null;

    if (!physW || !physH) {
      const buf = fs.readFileSync(imagePath);
      return { base64: buf.toString('base64'), dims: emptyDims(), tempPath: null };
    }

    // 物理像素 → 逻辑点
    const logW = physW / scaleFactor;
    const logH = physH / scaleFactor;
    // 逻辑点再 cap 到 MAX_EDGE_PX
    const longEdge = Math.max(logW, logH);
    const capRatio = longEdge > VISION_IMAGE.MAX_EDGE_PX ? VISION_IMAGE.MAX_EDGE_PX / longEdge : 1;
    const targetW = Math.max(1, Math.round(logW * capRatio));
    const targetH = Math.max(1, Math.round(logH * capRatio));

    // 目标尺寸 == 物理尺寸（scaleFactor=1 且未超 cap）→ 不 resize，原图直发
    if (targetW === physW && targetH === physH) {
      const buf = fs.readFileSync(imagePath);
      return {
        base64: buf.toString('base64'),
        dims: {
          originalWidth: physW,
          originalHeight: physH,
          analyzedWidth: physW,
          analyzedHeight: physH,
        },
        tempPath: null,
      };
    }

    const tempPath = path.join(os.tmpdir(), `code-agent-vision-resized-${Date.now()}.png`);
    await sharp(imagePath)
      .resize(targetW, targetH, { kernel: VISION_IMAGE.RESIZE_KERNEL })
      .png()
      .toFile(tempPath);

    // analyzedWidth/Height 从实际输出文件回读
    const outMeta = await sharp(tempPath).metadata();
    const analyzedWidth = outMeta.width ?? targetW;
    const analyzedHeight = outMeta.height ?? targetH;
    const buf = fs.readFileSync(tempPath);

    return {
      base64: buf.toString('base64'),
      dims: {
        originalWidth: physW,
        originalHeight: physH,
        analyzedWidth,
        analyzedHeight,
      },
      tempPath,
    };
  } catch (error) {
    logger.warn('Image preparation (resize) failed, sending original bytes', {
      imagePath,
      error: error instanceof Error ? error.message : String(error),
    });
    // 降级：发原始字节。文件完全读不出来才抛错。
    const buf = fs.readFileSync(imagePath);
    return { base64: buf.toString('base64'), dims: emptyDims(), tempPath: null };
  }
}

export async function analyzeImageWithVisionDetailed(args: {
  imagePath: string;
  prompt: string;
  source: string;
  timeoutMs?: number;
  /** 实测 backingScaleFactor（Phase 2 传入）；缺省用 VISION_IMAGE.FALLBACK_SCALE_FACTOR */
  scaleFactorHint?: number;
}): Promise<VisionAnalysisResult> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getZhipuOfficialKey();

  if (!zhipuApiKey) {
    logger.info('Vision analysis skipped: vision provider not configured', { source: args.source });
    return {
      ok: false,
      analysis: null,
      reason: 'missing_api_key',
      error: '复合视觉理解需要配置一个支持视觉的模型（如智谱 GLM-4.6V / GPT-4o / Claude / Gemini 2.5 / Qwen-VL / MiMo-VL / Doubao-VL / Kimi 视觉等）。请到设置→模型→视觉中配置后重试。OCR 不受影响，依然可通过 ocr_search 工具调用 macOS Vision Framework。',
      model: ZHIPU_VISION_MODEL,
      retryable: false,
      ...emptyDims(),
    };
  }

  const scaleFactor = args.scaleFactorHint && args.scaleFactorHint > 0
    ? args.scaleFactorHint
    : VISION_IMAGE.FALLBACK_SCALE_FACTOR;

  let prepared: { base64: string; dims: VisionImageDims; tempPath: string | null };
  try {
    prepared = await prepareImageForVision(args.imagePath, scaleFactor);
  } catch (error) {
    logger.warn('Vision analysis failed: image unreadable', {
      source: args.source,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      analysis: null,
      reason: 'exception',
      error: `Vision analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      model: ZHIPU_VISION_MODEL,
      retryable: true,
      ...emptyDims(),
    };
  }

  try {
    const response = await fetchWithTimeout(
      `${MODEL_API_ENDPOINTS.zhipuOfficial}/chat/completions`,
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
                    url: `data:image/png;base64,${prepared.base64}`,
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
        ...prepared.dims,
      };
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (content) {
      logger.info('Vision analysis completed', {
        source: args.source,
        contentLength: content.length,
        analyzedWidth: prepared.dims.analyzedWidth,
        analyzedHeight: prepared.dims.analyzedHeight,
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
        ...prepared.dims,
      };
    }

    return {
      ok: true,
      analysis: content,
      model: ZHIPU_VISION_MODEL,
      ...prepared.dims,
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
      ...prepared.dims,
    };
  } finally {
    if (prepared.tempPath) {
      await fs.promises.unlink(prepared.tempPath).catch(() => undefined);
    }
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
