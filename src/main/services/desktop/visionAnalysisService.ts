import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import { ZHIPU_VISION_MODEL, VISION_IMAGE, DEFAULT_PROVIDER, DEFAULT_MODELS } from '../../../shared/constants';
import { ModelRouter } from '../../model/modelRouter';
import type { ModelConfig, ModelProvider } from '../../../shared/contract/model';
import { loadSharp } from '../../runtime/sharpRuntime';

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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
    const sharpRuntime = loadSharp();
    if (!sharpRuntime.ok || !sharpRuntime.sharp) {
      throw new Error(sharpRuntime.error ?? 'Sharp image runtime is unavailable.');
    }
    const sharp = sharpRuntime.sharp;

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

// 单例 ModelRouter，避免每次 analyzeImage 都重建（cache provider 实例化开销）
let sharedRouter: ModelRouter | null = null;
function getSharedRouter(): ModelRouter {
  if (!sharedRouter) sharedRouter = new ModelRouter();
  return sharedRouter;
}

/**
 * 根据用户配置选 vision provider/model：
 * 1. 优先用 settings.models.routing.vision（用户在设置→模型→视觉显式指定的）
 * 2. 检查 model 是否 supportsVision（model-catalog.json 标记）
 * 3. 用 configService.getApiKey 拿对应 provider 的 key
 * 4. 都拿不到时返回 null，调用方给清晰提示
 */
function resolveVisionModelConfig(): ModelConfig | null {
  const configService = getConfigService();
  const settings = configService.getSettings();
  const visionRouting = configService.getModelForCapability('vision');
  if (!visionRouting?.provider || !visionRouting.model) return null;

  const provider = visionRouting.provider as ModelProvider;
  const model = visionRouting.model;

  // ModelInfo + supportsVision 检查
  const router = getSharedRouter();
  const modelInfo = router.getModelInfo(provider, model);
  if (!modelInfo?.supportsVision) {
    logger.warn('vision routing model does not support vision', { provider, model });
    return null;
  }

  const apiKey = configService.getApiKey(provider) || '';
  // 兼容部分 provider 无需 apiKey 的情况（如本地 Ollama），让 ModelRouter 内部决定
  const baseUrl = settings.models?.providers?.[provider]?.baseUrl;

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    temperature: 0.3,
    maxTokens: 2048,
  };
}

/**
 * 构建视觉候选的 seed 配置：优先用户配置的 routing.vision；没配则退回 chat 路由，
 * 让 getVisionPreflightCandidates 以"同 provider 视觉模型优先"挑候选（如 chat=xiaomi
 * → 优先 mimo-omni）。getVisionPreflightCandidates 只用到 provider/apiKey/baseUrl/temp。
 */
function buildVisionBaseConfig(): ModelConfig {
  const configured = resolveVisionModelConfig();
  if (configured) return configured;

  // 视觉未配置（或配的模型不支持视觉）时，用默认 provider 兜底 seed，
  // 让 getVisionPreflightCandidates 以默认 provider 的视觉模型优先（如 xiaomi → mimo-omni）。
  const configService = getConfigService();
  const provider = DEFAULT_PROVIDER as ModelProvider;
  return {
    provider,
    model: DEFAULT_MODELS.chat,
    apiKey: configService.getApiKey(provider) || '',
    baseUrl: configService.getSettings().models?.providers?.[provider]?.baseUrl,
    temperature: 0.3,
    maxTokens: 2048,
  };
}

const MISSING_VISION_MODEL_MESSAGE =
  '复合视觉理解需要配置一个支持视觉的模型（如智谱 GLM-4.6V / GPT-4o / Claude 4.6+ / Gemini 2.5 / Qwen-VL / MiMo-VL / Doubao-VL / Kimi 视觉等）。请到设置→模型→视觉中选择后重试。OCR 不受影响，依然可通过 ocr_search 工具调用 macOS Vision Framework。';

export async function analyzeImageWithVisionDetailed(args: {
  imagePath: string;
  prompt: string;
  source: string;
  timeoutMs?: number;
  /** 实测 backingScaleFactor（Phase 2 传入）；缺省用 VISION_IMAGE.FALLBACK_SCALE_FACTOR */
  scaleFactorHint?: number;
}): Promise<VisionAnalysisResult> {
  // 智能候选路由：同 provider 视觉模型优先 + 逐个 try + 自动兜底（替代原来直连
  // 单一 routing.vision 配置——那样一旦配的模型 403/无权限就直接失败不兜底）。
  const router = getSharedRouter();
  const candidates = router.getVisionPreflightCandidates(buildVisionBaseConfig());
  const reportedModel = resolveVisionModelConfig()?.model || ZHIPU_VISION_MODEL;

  if (candidates.length === 0) {
    logger.info('Vision analysis skipped: no usable vision model (no configured key)', { source: args.source });
    return {
      ok: false,
      analysis: null,
      reason: 'missing_api_key',
      error: MISSING_VISION_MODEL_MESSAGE,
      model: reportedModel,
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
      model: reportedModel,
      retryable: true,
      ...emptyDims(),
    };
  }

  const timeoutMs = args.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    let lastErr = '';
    let lastAborted = false;
    let lastModel = reportedModel;

    // 逐个候选尝试，首个成功即返回；全失败则带可执行引导返回
    for (const cfg of candidates) {
      lastModel = cfg.model;
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
      try {
        const response = await Promise.race([
          router.inferenceWithVision(
            [{ role: 'user', content: args.prompt }],
            [{ data: prepared.base64, mediaType: 'image/png' }],
            { ...cfg, maxTokens: Math.min(cfg.maxTokens || 2048, 2048) },
          ),
          new Promise<never>((_, reject) => {
            timeoutController.signal.addEventListener('abort', () => {
              reject(new Error('vision_analysis_timeout'));
            }, { once: true });
          }),
        ]);

        const content = response.content?.trim() || '';
        if (!content) {
          lastErr = 'Vision analysis returned empty content';
          lastAborted = false;
          logger.warn('Vision analysis returned empty content, trying next candidate', {
            source: args.source, provider: cfg.provider, model: cfg.model,
          });
          continue;
        }

        logger.info('Vision analysis completed', {
          source: args.source,
          provider: response.actualProvider || cfg.provider,
          model: response.actualModel || cfg.model,
          contentLength: content.length,
          triedCandidates: candidates.indexOf(cfg) + 1,
        });
        return {
          ok: true,
          analysis: content,
          model: response.actualModel || cfg.model,
          ...prepared.dims,
        };
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        lastErr = errMsg;
        lastAborted = errMsg === 'vision_analysis_timeout' || isAbortError(error);
        logger.warn(lastAborted ? 'Vision candidate timed out, trying next' : 'Vision candidate failed, trying next', {
          source: args.source, provider: cfg.provider, model: cfg.model, error: errMsg,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    // 所有候选都失败 —— 附上可执行引导（去配置/换视觉模型），让模型/用户能自纠
    return {
      ok: false,
      analysis: null,
      reason: lastAborted ? 'timeout' : 'exception',
      error: lastAborted
        ? `Vision analysis timed out after ${timeoutMs}ms（已尝试 ${candidates.length} 个视觉模型）`
        : `Vision analysis failed: ${lastErr}。已尝试 ${candidates.length} 个已配置的视觉模型均失败。${MISSING_VISION_MODEL_MESSAGE}`,
      model: lastModel,
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
