// ============================================================================
// image_annotate (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy ImageAnnotateTool 迁移到 native：百度 OCR API（精确坐标）+
// sharp SVG composite 绘制矩形/圆/箭头/高亮 + 智谱视觉模型降级（仅返回内容描述）。
//
// abort signal 走 race-and-abandon：fetch + sharp 都用 ctx.abortSignal。
// 每个 fetch 都有内置 AbortController 与 outerSignal 联动。
//
// 行为保真：legacy 中文文案、emoji（🔍 📡 ⚠️ 🖍️ 📍 📄 📝 🔧）、
// SVG 多彩色板（12 色循环）、序号标签背景框、降级路径描述、metadata 形状
// （imagePath/annotatedPath/regions/ocrMethod）1:1 复刻。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getConfigService } from '../../../services';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS, BAIDU_OCR_ENDPOINTS } from '../../../../shared/constants';
import { createFileArtifact, createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { imageAnnotateSchema as schema } from './imageAnnotate.schema';
import {
  isJsonRecord,
  readArrayField,
  readChatCompletionText,
  readNumberField,
  readRecordField,
  readStringField,
} from '../typedResponseGuards';
import { requireSharp } from '../../../runtime/sharpRuntime';

const CONFIG = {
  ZHIPU_MODEL: ZHIPU_VISION_MODEL,
  ZHIPU_MODEL_MAX_TOKENS: 2048,
  ZHIPU_API_URL: `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
  BAIDU_OCR_TOKEN_URL: BAIDU_OCR_ENDPOINTS.token,
  BAIDU_OCR_API_URL: BAIDU_OCR_ENDPOINTS.accurate,
  TIMEOUT_MS: 60000,
  SUPPORTED_FORMATS: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'],
  MAX_IMAGE_SIZE_MB: 10,
};

type AnnotationType = 'circle' | 'rectangle' | 'arrow' | 'text' | 'highlight';

interface AnnotationRegion {
  type: AnnotationType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  endX?: number;
  endY?: number;
  label?: string;
  color?: string;
  confidence?: number;
}

interface BaiduOCRWord {
  words: string;
  location: { top: number; left: number; width: number; height: number };
  probability?: { average: number };
}
interface BaiduOCRResponse {
  words_result?: BaiduOCRWord[];
  words_result_num?: number;
  error_code?: number;
  error_msg?: string;
}

interface BaiduAccessTokenResponse {
  accessToken?: string;
  error?: string;
  errorDescription?: string;
}

interface ImageAnnotateParams {
  image_path: string;
  query: string;
  output_path?: string;
  draw_annotations?: boolean;
  show_labels?: boolean;
  stroke_color?: string;
}

async function fetchWithAbort(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener('abort', onOuterAbort);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function normalizeBaiduAccessTokenResponse(payload: unknown): BaiduAccessTokenResponse {
  if (!isJsonRecord(payload)) return {};
  return {
    accessToken: readStringField(payload, 'access_token'),
    error: readStringField(payload, 'error'),
    errorDescription: readStringField(payload, 'error_description'),
  };
}

function normalizeBaiduOCRWord(payload: unknown): BaiduOCRWord | undefined {
  if (!isJsonRecord(payload)) return undefined;
  const location = readRecordField(payload, 'location');
  if (!location) return undefined;
  const top = readNumberField(location, 'top');
  const left = readNumberField(location, 'left');
  const width = readNumberField(location, 'width');
  const height = readNumberField(location, 'height');
  const words = readStringField(payload, 'words');
  if (top === undefined || left === undefined || width === undefined || height === undefined || !words) {
    return undefined;
  }

  const word: BaiduOCRWord = {
    words,
    location: { top, left, width, height },
  };
  const probability = readRecordField(payload, 'probability');
  const average = probability ? readNumberField(probability, 'average') : undefined;
  if (average !== undefined) {
    word.probability = { average };
  }
  return word;
}

function normalizeBaiduOCRResponse(payload: unknown): BaiduOCRResponse {
  if (!isJsonRecord(payload)) return {};
  const response: BaiduOCRResponse = {};
  const wordsResult = readArrayField(payload, 'words_result')
    ?.map(normalizeBaiduOCRWord)
    .filter((word): word is BaiduOCRWord => Boolean(word));
  if (wordsResult) response.words_result = wordsResult;
  const wordsResultNum = readNumberField(payload, 'words_result_num');
  if (wordsResultNum !== undefined) response.words_result_num = wordsResultNum;
  const errorCode = readNumberField(payload, 'error_code');
  if (errorCode !== undefined) response.error_code = errorCode;
  const errorMessage = readStringField(payload, 'error_msg');
  if (errorMessage !== undefined) response.error_msg = errorMessage;
  return response;
}

async function getBaiduAccessToken(
  apiKey: string,
  secretKey: string,
  outerSignal: AbortSignal,
): Promise<string> {
  const url = `${CONFIG.BAIDU_OCR_TOKEN_URL}?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;
  const response = await fetchWithAbort(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    CONFIG.TIMEOUT_MS,
    outerSignal,
  );
  if (!response.ok) {
    throw new Error(`获取百度 Access Token 失败: ${response.status}`);
  }
  const data = normalizeBaiduAccessTokenResponse(await response.json());
  if (data.error) {
    throw new Error(`百度 API 错误: ${data.errorDescription || data.error}`);
  }
  if (!data.accessToken) {
    throw new Error('百度 API 错误: 未返回 Access Token');
  }
  return data.accessToken;
}

async function callBaiduOCR(
  accessToken: string,
  base64Image: string,
  outerSignal: AbortSignal,
): Promise<AnnotationRegion[]> {
  const url = `${CONFIG.BAIDU_OCR_API_URL}?access_token=${accessToken}`;
  const response = await fetchWithAbort(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `image=${encodeURIComponent(base64Image)}&detect_direction=true&paragraph=false&probability=true`,
    },
    CONFIG.TIMEOUT_MS,
    outerSignal,
  );
  if (!response.ok) {
    throw new Error(`百度 OCR API 错误: ${response.status}`);
  }
  const data = normalizeBaiduOCRResponse(await response.json());
  if (data.error_code) {
    throw new Error(`百度 OCR 错误 ${data.error_code}: ${data.error_msg}`);
  }
  if (!data.words_result || data.words_result.length === 0) {
    return [];
  }
  return data.words_result.map((word) => ({
    type: 'rectangle' as AnnotationType,
    x: word.location.left,
    y: word.location.top,
    width: word.location.width,
    height: word.location.height,
    label: word.words,
    confidence: word.probability?.average,
  }));
}

async function analyzeImageContent(
  apiKey: string,
  base64Image: string,
  mimeType: string,
  query: string,
  outerSignal: AbortSignal,
): Promise<string> {
  const instruction = `请仔细分析这张图片，${query}\n请直接描述图片内容，不需要返回坐标信息。`;
  const requestBody = {
    model: CONFIG.ZHIPU_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        ],
      },
    ],
    max_tokens: CONFIG.ZHIPU_MODEL_MAX_TOKENS,
  };
  const response = await fetchWithAbort(
    CONFIG.ZHIPU_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    CONFIG.TIMEOUT_MS,
    outerSignal,
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`智谱视觉 API 错误: ${response.status} - ${errorText}`);
  }
  return readChatCompletionText(await response.json());
}

async function drawAnnotations(
  imagePath: string,
  regions: AnnotationRegion[],
  outputPath: string,
  options: { showLabels?: boolean; strokeColor?: string; strokeWidth?: number },
  signal: AbortSignal,
): Promise<void> {
  const sharp = requireSharp();
  const image = sharp(imagePath);
  const metadata = await withAbort(image.metadata(), signal);
  const imgWidth = metadata.width || 800;
  const imgHeight = metadata.height || 600;

  const strokeColor = options.strokeColor || '#FF0000';
  const defaultStrokeWidth = Math.max(2, Math.min(imgWidth, imgHeight) / 300);
  const strokeWidth = options.strokeWidth || defaultStrokeWidth;
  const showLabels = options.showLabels !== false;

  let svgOverlay = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">`;

  const colors = [
    '#FF0000', '#00FF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFF00',
    '#FF6600', '#6600FF', '#00FF66', '#FF0066', '#66FF00', '#0066FF',
  ];

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const color = region.color || colors[i % colors.length];

    switch (region.type) {
      case 'circle':
        svgOverlay += `
          <circle
            cx="${region.x + (region.width || 0) / 2}"
            cy="${region.y + (region.height || 0) / 2}"
            r="${region.radius || Math.max(region.width || 30, region.height || 30) / 2}"
            fill="none"
            stroke="${color}"
            stroke-width="${strokeWidth}"
          />`;
        break;

      case 'rectangle':
        svgOverlay += `
          <rect
            x="${region.x}"
            y="${region.y}"
            width="${region.width || 100}"
            height="${region.height || 30}"
            fill="none"
            stroke="${color}"
            stroke-width="${strokeWidth}"
          />`;
        break;

      case 'arrow': {
        const endX = region.endX || region.x + 50;
        const endY = region.endY || region.y;
        const arrowSize = strokeWidth * 3;
        const angle = Math.atan2(endY - region.y, endX - region.x);
        const arrowX1 = endX - arrowSize * Math.cos(angle - Math.PI / 6);
        const arrowY1 = endY - arrowSize * Math.sin(angle - Math.PI / 6);
        const arrowX2 = endX - arrowSize * Math.cos(angle + Math.PI / 6);
        const arrowY2 = endY - arrowSize * Math.sin(angle + Math.PI / 6);
        svgOverlay += `
          <line
            x1="${region.x}"
            y1="${region.y}"
            x2="${endX}"
            y2="${endY}"
            stroke="${color}"
            stroke-width="${strokeWidth}"
          />
          <polygon
            points="${endX},${endY} ${arrowX1},${arrowY1} ${arrowX2},${arrowY2}"
            fill="${color}"
          />`;
        break;
      }

      case 'highlight':
        svgOverlay += `
          <rect
            x="${region.x}"
            y="${region.y}"
            width="${region.width || 100}"
            height="${region.height || 50}"
            fill="${color}"
            fill-opacity="0.3"
            stroke="${color}"
            stroke-width="${strokeWidth / 2}"
          />`;
        break;
    }

    if (showLabels && region.type === 'rectangle') {
      const fontSize = Math.max(12, Math.min(imgWidth, imgHeight) / 60);
      const labelX = region.x;
      const labelY = region.y - 3;
      svgOverlay += `
        <rect
          x="${labelX - 2}"
          y="${labelY - fontSize}"
          width="${fontSize * 1.5}"
          height="${fontSize + 4}"
          fill="white"
          fill-opacity="0.8"
        />
        <text
          x="${labelX}"
          y="${labelY}"
          fill="${color}"
          font-size="${fontSize}"
          font-family="Arial, sans-serif"
          font-weight="bold"
        >${i + 1}</text>`;
    }
  }

  svgOverlay += '</svg>';
  // 保留 strokeColor 默认值（虽未直接使用但保持 legacy options 形参语义）
  void strokeColor;

  await withAbort(
    image
      .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
      .toFile(outputPath),
    signal,
  );
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  return map[ext] || 'image/png';
}

export async function executeImageAnnotate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const params = args as unknown as ImageAnnotateParams;
  if (typeof params.image_path !== 'string' || params.image_path.length === 0) {
    return { ok: false, error: 'image_path is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof params.query !== 'string' || params.query.length === 0) {
    return { ok: false, error: 'query is required and must be a string', code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();

  try {
    const configService = getConfigService();
    const baiduApiKey = process.env.BAIDU_OCR_API_KEY;
    const baiduSecretKey = process.env.BAIDU_OCR_SECRET_KEY;
    const zhipuApiKey = configService.getApiKey('zhipu');

    let imagePath = params.image_path;
    if (!path.isAbsolute(imagePath)) {
      imagePath = path.join(ctx.workingDir, imagePath);
    }

    if (!fs.existsSync(imagePath)) {
      return { ok: false, error: `文件不存在: ${imagePath}`, code: 'FS_ERROR' };
    }

    const ext = path.extname(imagePath).toLowerCase();
    if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
      return {
        ok: false,
        error: `不支持的图片格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
        code: 'INVALID_ARGS',
      };
    }

    const stats = fs.statSync(imagePath);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > CONFIG.MAX_IMAGE_SIZE_MB) {
      return {
        ok: false,
        error: `文件过大: ${sizeMB.toFixed(2)}MB。最大支持 ${CONFIG.MAX_IMAGE_SIZE_MB}MB`,
        code: 'INVALID_ARGS',
      };
    }

    ctx.emit({
      type: 'tool_output',
      tool: 'image_annotate',
      message: '🔍 正在识别图片中的文字...',
    } as never);

    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');
    const mimeType = getMimeType(imagePath);

    let regions: AnnotationRegion[] = [];
    let ocrMethod: 'baidu' | 'vision_llm' | 'none' = 'none';
    let description = '';

    if (baiduApiKey && baiduSecretKey) {
      try {
        ctx.emit({
          type: 'tool_output',
          tool: 'image_annotate',
          message: '📡 使用百度 OCR 获取精确坐标...',
        } as never);

        const accessToken = await getBaiduAccessToken(baiduApiKey, baiduSecretKey, ctx.abortSignal);
        regions = await callBaiduOCR(accessToken, base64Image, ctx.abortSignal);
        ocrMethod = 'baidu';

        if (regions.length > 0) {
          description = `识别到 ${regions.length} 处文字：\n`;
          regions.forEach((r, i) => {
            description += `${i + 1}. ${r.label}\n`;
          });
        } else {
          description = '未识别到文字内容';
        }
      } catch (error: unknown) {
        if (ctx.abortSignal.aborted) {
          return { ok: false, error: 'aborted', code: 'ABORTED' };
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn('image_annotate baidu OCR failed', { error: message });
      }
    }

    if (regions.length === 0 && zhipuApiKey) {
      ctx.emit({
        type: 'tool_output',
        tool: 'image_annotate',
        message: '⚠️ 百度 OCR 未配置，使用视觉模型分析（坐标可能不精确）...',
      } as never);

      description = await analyzeImageContent(
        zhipuApiKey,
        base64Image,
        mimeType,
        params.query,
        ctx.abortSignal,
      );
      ocrMethod = 'vision_llm';

      onProgress?.({ stage: 'completing', percent: 100 });

      return {
        ok: true,
        output: `📝 图片内容分析（无法精确标注）:\n\n${description}\n\n⚠️ 如需精确的矩形框标注，请配置百度 OCR API：\n- BAIDU_OCR_API_KEY: 百度云 API Key\n- BAIDU_OCR_SECRET_KEY: 百度云 Secret Key\n\n申请地址: https://cloud.baidu.com/product/ocr`,
        meta: {
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `Image annotation analysis: ${path.basename(imagePath)}`,
            mimeType: 'text/markdown',
            contentLength: description.length,
            preview: description.slice(0, 500),
            metadata: {
              imagePath,
              query: params.query,
              ocrMethod,
              mediaKind: 'image',
            },
          }),
          imagePath,
          description,
          ocrMethod,
          query: params.query,
          mediaKind: 'image',
          contentLength: description.length,
          truncated: false,
          processingTimeMs: Date.now() - startTime,
        },
      };
    }

    if (regions.length === 0 && !zhipuApiKey) {
      return {
        ok: false,
        error: '图片标注需要配置 OCR API。\n\n推荐配置百度 OCR（精确坐标）:\n- BAIDU_OCR_API_KEY\n- BAIDU_OCR_SECRET_KEY\n\n或配置智谱 API（仅分析内容，无法精确标注）',
        code: 'NOT_INITIALIZED',
      };
    }

    let output = `📝 识别结果:\n${description}`;
    let annotatedPath: string | undefined;

    const shouldDraw = params.draw_annotations !== false;
    if (shouldDraw && regions.length > 0) {
      ctx.emit({
        type: 'tool_output',
        tool: 'image_annotate',
        message: `🖍️ 正在绘制 ${regions.length} 个标注...`,
      } as never);

      const timestamp = Date.now();
      const baseName = path.basename(imagePath, ext);
      annotatedPath = params.output_path
        ? path.isAbsolute(params.output_path)
          ? params.output_path
          : path.join(ctx.workingDir, params.output_path)
        : path.join(ctx.workingDir, `${baseName}_annotated_${timestamp}${ext}`);

      await drawAnnotations(
        imagePath,
        regions,
        annotatedPath,
        { showLabels: params.show_labels, strokeColor: params.stroke_color },
        ctx.abortSignal,
      );

      output += `\n\n📍 标注区域: ${regions.length} 个`;
      output += `\n📄 标注图片: ${annotatedPath}`;
      output += `\n🔧 OCR 方法: ${ocrMethod === 'baidu' ? '百度 OCR（精确坐标）' : '视觉模型'}`;
    } else if (regions.length === 0 && shouldDraw) {
      output += '\n\n⚠️ 未能识别到需要标注的文字区域';
    }

    const processingTime = Date.now() - startTime;
    onProgress?.({ stage: 'completing', percent: 100 });
    const artifact = annotatedPath
      ? await createFileArtifact(annotatedPath, schema.name, ctx, {
          kind: 'image',
          mimeType,
          metadata: {
            imagePath,
            query: params.query,
            ocrMethod,
            regionCount: regions.length,
            mediaKind: 'image',
          },
        })
      : createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          sessionId: ctx.sessionId,
          name: `Image annotations: ${path.basename(imagePath)}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            imagePath,
            query: params.query,
            ocrMethod,
            regionCount: regions.length,
            mediaKind: 'image',
          },
        });

    return {
      ok: true,
      output,
      meta: {
        artifact,
        imagePath,
        annotatedPath,
        description,
        regions,
        regionCount: regions.length,
        ocrMethod,
        query: params.query,
        mediaKind: 'image',
        outputPath: annotatedPath,
        contentLength: output.length,
        truncated: false,
        processingTimeMs: processingTime,
        attachment: annotatedPath
          ? {
              id: `annotated-${Date.now()}`,
              type: 'file',
              category: 'image',
              name: path.basename(annotatedPath),
              path: annotatedPath,
              mimeType,
            }
          : undefined,
      },
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('image_annotate failed', { error: message });
    return { ok: false, error: `图片标注失败: ${message}` };
  }
}

class ImageAnnotateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeImageAnnotate(args, ctx, canUseTool, onProgress);
  }
}

export const imageAnnotateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ImageAnnotateHandler();
  },
};
