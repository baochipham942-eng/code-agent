// ============================================================================
// Image Annotate Tool - 图片理解与标注
// 使用 OCR 获取真实文字坐标，在图片上绘制精确的矩形框标注
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS } from '../../../shared/constants';

const logger = createLogger('ImageAnnotate');

// 配置
const CONFIG = {
  // 智谱视觉模型配置（用于图片理解，不用于坐标定位）
  ZHIPU_MODEL: ZHIPU_VISION_MODEL,
  ZHIPU_MODEL_MAX_TOKENS: 2048,
  ZHIPU_API_URL: `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
  // 百度 OCR API 配置
  BAIDU_OCR_TOKEN_URL: 'https://aip.baidubce.com/oauth/2.0/token',
  BAIDU_OCR_API_URL: 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate',
  // 通用配置
  TIMEOUT_MS: 60000,
  SUPPORTED_FORMATS: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'],
  MAX_IMAGE_SIZE_MB: 10, // 百度 OCR 限制 10MB
};

// 标注类型
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
  confidence?: number; // OCR 置信度
}

interface AnnotationResult {
  description: string;
  regions: AnnotationRegion[];
  ocrMethod: 'baidu' | 'vision_llm' | 'none';
}

// 百度 OCR 响应类型
interface BaiduOCRWord {
  words: string;
  location: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
  probability?: {
    average: number;
  };
}

interface BaiduOCRResponse {
  words_result?: BaiduOCRWord[];
  words_result_num?: number;
  error_code?: number;
  error_msg?: string;
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 获取百度 OCR Access Token
 */
async function getBaiduAccessToken(apiKey: string, secretKey: string): Promise<string> {
  const url = `${CONFIG.BAIDU_OCR_TOKEN_URL}?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, CONFIG.TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`获取百度 Access Token 失败: ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`百度 API 错误: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

/**
 * 调用百度 OCR API 获取文字位置（精确坐标）
 */
async function callBaiduOCR(
  accessToken: string,
  base64Image: string
): Promise<AnnotationRegion[]> {
  const url = `${CONFIG.BAIDU_OCR_API_URL}?access_token=${accessToken}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `image=${encodeURIComponent(base64Image)}&detect_direction=true&paragraph=false&probability=true`,
  }, CONFIG.TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`百度 OCR API 错误: ${response.status}`);
  }

  const data: BaiduOCRResponse = await response.json();

  if (data.error_code) {
    throw new Error(`百度 OCR 错误 ${data.error_code}: ${data.error_msg}`);
  }

  if (!data.words_result || data.words_result.length === 0) {
    return [];
  }

  // 转换为标注区域
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

/**
 * 调用智谱视觉模型分析图片内容（仅用于理解，不用于坐标定位）
 */
async function analyzeImageContent(
  apiKey: string,
  base64Image: string,
  mimeType: string,
  query: string
): Promise<string> {
  const instruction = `请仔细分析这张图片，${query}
请直接描述图片内容，不需要返回坐标信息。`;

  const requestBody = {
    model: CONFIG.ZHIPU_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: CONFIG.ZHIPU_MODEL_MAX_TOKENS,
  };

  logger.info('[图片标注] 调用智谱视觉模型分析内容', { query });

  const response = await fetchWithTimeout(
    CONFIG.ZHIPU_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    CONFIG.TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`智谱视觉 API 错误: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

/**
 * 使用 sharp 在图片上绘制标注
 */
async function drawAnnotations(
  imagePath: string,
  regions: AnnotationRegion[],
  outputPath: string,
  options: {
    showLabels?: boolean;
    strokeColor?: string;
    strokeWidth?: number;
  } = {}
): Promise<void> {
  // 动态导入 sharp
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new Error('sharp 库未安装，无法绘制标注。请运行: npm install sharp');
  }

  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const imgWidth = metadata.width || 800;
  const imgHeight = metadata.height || 600;

  // 默认配置
  const strokeColor = options.strokeColor || '#FF0000';
  const defaultStrokeWidth = Math.max(2, Math.min(imgWidth, imgHeight) / 300);
  const strokeWidth = options.strokeWidth || defaultStrokeWidth;
  const showLabels = options.showLabels !== false;

  // 构建 SVG 覆盖层
  let svgOverlay = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">`;

  // 生成不同颜色用于区分不同的标注区域
  const colors = [
    '#FF0000', '#00FF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFF00',
    '#FF6600', '#6600FF', '#00FF66', '#FF0066', '#66FF00', '#0066FF'
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

      case 'arrow':
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

    // 添加序号标签（不显示完整文字，避免遮挡）
    if (showLabels && region.type === 'rectangle') {
      const fontSize = Math.max(12, Math.min(imgWidth, imgHeight) / 60);
      const labelX = region.x;
      const labelY = region.y - 3;

      // 添加背景框使序号更清晰
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

  // 将 SVG 叠加到图片上
  await image
    .composite([{
      input: Buffer.from(svgOverlay),
      top: 0,
      left: 0,
    }])
    .toFile(outputPath);

  logger.info('[图片标注] 标注完成', { outputPath, regionCount: regions.length });
}

/**
 * 转义 XML 特殊字符
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 获取 MIME 类型
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  return mimeTypes[ext] || 'image/png';
}

interface ImageAnnotateParams {
  image_path: string;
  query: string;
  output_path?: string;
  draw_annotations?: boolean;
  show_labels?: boolean;
  stroke_color?: string;
}

export const imageAnnotateTool: Tool = {
  name: 'image_annotate',
  description: `在图片上绘制矩形框标注文字位置，输出带标记的新图片。

**触发关键词**（用户提到这些词时必须使用此工具）：
- "矩形框"、"矩形工具"、"框出"、"画框"、"标记"
- "在图片上标注"、"在截图上画"、"圈出"
- "用框框起来"、"框选"、"标出位置"

**核心能力**：
1. 使用 OCR 精确识别文字位置（百度 OCR API）
2. 在原图上绘制精确的矩形框
3. 输出带标注的新图片文件

**使用场景**：
- 用户发送图片并要求"用矩形框框出文字"
- 用户要求"在截图上标记按钮位置"
- 用户说"框出图片中的XX"

参数：
- image_path: 图片路径
- query: 标注指令，如"用矩形框框出所有文字"
- output_path: 输出路径（可选）
- show_labels: 是否显示序号标签（默认 true）

**需要配置**：
- 百度 OCR API（需要 BAIDU_OCR_API_KEY 和 BAIDU_OCR_SECRET_KEY）
- 或智谱 API Key（降级方案，坐标不精确）`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: '图片文件路径',
      },
      query: {
        type: 'string',
        description: '分析问题或标注指令',
      },
      output_path: {
        type: 'string',
        description: '标注后的图片保存路径',
      },
      draw_annotations: {
        type: 'boolean',
        description: '是否绘制标注（默认 true）',
        default: true,
      },
      show_labels: {
        type: 'boolean',
        description: '是否显示序号标签（默认 true）',
        default: true,
      },
      stroke_color: {
        type: 'string',
        description: '标注框颜色（默认多彩）',
      },
    },
    required: ['image_path', 'query'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const typedParams = params as unknown as ImageAnnotateParams;
    const startTime = Date.now();

    try {
      const configService = getConfigService();

      // 获取 API Keys
      // 百度 OCR 只通过环境变量配置
      const baiduApiKey = process.env.BAIDU_OCR_API_KEY;
      const baiduSecretKey = process.env.BAIDU_OCR_SECRET_KEY;
      const zhipuApiKey = configService.getApiKey('zhipu');

      // 解析文件路径
      let imagePath = typedParams.image_path;
      if (!path.isAbsolute(imagePath)) {
        imagePath = path.join(context.workingDirectory, imagePath);
      }

      // 检查文件是否存在
      if (!fs.existsSync(imagePath)) {
        return {
          success: false,
          error: `文件不存在: ${imagePath}`,
        };
      }

      // 检查文件格式
      const ext = path.extname(imagePath).toLowerCase();
      if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
        return {
          success: false,
          error: `不支持的图片格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
        };
      }

      // 检查文件大小
      const stats = fs.statSync(imagePath);
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB > CONFIG.MAX_IMAGE_SIZE_MB) {
        return {
          success: false,
          error: `文件过大: ${sizeMB.toFixed(2)}MB。最大支持 ${CONFIG.MAX_IMAGE_SIZE_MB}MB`,
        };
      }

      context.emit?.('tool_output', {
        tool: 'image_annotate',
        message: '🔍 正在识别图片中的文字...',
      });

      // 读取图片并转 base64
      const imageData = fs.readFileSync(imagePath);
      const base64Image = imageData.toString('base64');
      const mimeType = getMimeType(imagePath);

      let regions: AnnotationRegion[] = [];
      let ocrMethod: 'baidu' | 'vision_llm' | 'none' = 'none';
      let description = '';

      // 优先使用百度 OCR（精确坐标）
      if (baiduApiKey && baiduSecretKey) {
        try {
          context.emit?.('tool_output', {
            tool: 'image_annotate',
            message: '📡 使用百度 OCR 获取精确坐标...',
          });

          const accessToken = await getBaiduAccessToken(baiduApiKey, baiduSecretKey);
          regions = await callBaiduOCR(accessToken, base64Image);
          ocrMethod = 'baidu';

          // 构建描述
          if (regions.length > 0) {
            description = `识别到 ${regions.length} 处文字：\n`;
            regions.forEach((r, i) => {
              description += `${i + 1}. ${r.label}\n`;
            });
          } else {
            description = '未识别到文字内容';
          }

          logger.info('[图片标注] 百度 OCR 识别完成', { regionCount: regions.length });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('[图片标注] 百度 OCR 失败，尝试降级方案', { error: message });
          // 降级到视觉模型
        }
      }

      // 如果百度 OCR 失败或未配置，且有智谱 API，使用视觉模型分析
      if (regions.length === 0 && zhipuApiKey) {
        context.emit?.('tool_output', {
          tool: 'image_annotate',
          message: '⚠️ 百度 OCR 未配置，使用视觉模型分析（坐标可能不精确）...',
        });

        description = await analyzeImageContent(
          zhipuApiKey,
          base64Image,
          mimeType,
          typedParams.query
        );
        ocrMethod = 'vision_llm';

        // 视觉模型无法提供精确坐标，返回分析结果但不绘制标注
        return {
          success: true,
          output: `📝 图片内容分析（无法精确标注）:\n\n${description}\n\n⚠️ 如需精确的矩形框标注，请配置百度 OCR API：\n- BAIDU_OCR_API_KEY: 百度云 API Key\n- BAIDU_OCR_SECRET_KEY: 百度云 Secret Key\n\n申请地址: https://cloud.baidu.com/product/ocr`,
          metadata: {
            imagePath,
            description,
            ocrMethod,
            processingTimeMs: Date.now() - startTime,
          },
        };
      }

      // 如果没有任何 API 配置
      if (regions.length === 0 && !zhipuApiKey) {
        return {
          success: false,
          error: '图片标注需要配置 OCR API。\n\n推荐配置百度 OCR（精确坐标）:\n- BAIDU_OCR_API_KEY\n- BAIDU_OCR_SECRET_KEY\n\n或配置智谱 API（仅分析内容，无法精确标注）',
        };
      }

      let output = `📝 识别结果:\n${description}`;
      let annotatedPath: string | undefined;

      // 绘制标注
      const shouldDraw = typedParams.draw_annotations !== false;
      if (shouldDraw && regions.length > 0) {
        context.emit?.('tool_output', {
          tool: 'image_annotate',
          message: `🖍️ 正在绘制 ${regions.length} 个标注...`,
        });

        // 确定输出路径
        const timestamp = Date.now();
        const baseName = path.basename(imagePath, ext);
        annotatedPath = typedParams.output_path
          ? (path.isAbsolute(typedParams.output_path)
              ? typedParams.output_path
              : path.join(context.workingDirectory, typedParams.output_path))
          : path.join(context.workingDirectory, `${baseName}_annotated_${timestamp}${ext}`);

        // 绘制标注
        await drawAnnotations(imagePath, regions, annotatedPath, {
          showLabels: typedParams.show_labels,
          strokeColor: typedParams.stroke_color,
        });

        output += `\n\n📍 标注区域: ${regions.length} 个`;
        output += `\n📄 标注图片: ${annotatedPath}`;
        output += `\n🔧 OCR 方法: ${ocrMethod === 'baidu' ? '百度 OCR（精确坐标）' : '视觉模型'}`;
      } else if (regions.length === 0 && shouldDraw) {
        output += '\n\n⚠️ 未能识别到需要标注的文字区域';
      }

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        output,
        metadata: {
          imagePath,
          annotatedPath,
          description,
          regions,
          ocrMethod,
          processingTimeMs: processingTime,
          attachment: annotatedPath ? {
            id: `annotated-${Date.now()}`,
            type: 'file',
            category: 'image',
            name: path.basename(annotatedPath),
            path: annotatedPath,
            mimeType,
          } : undefined,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[图片标注] 失败', { error: message });
      return {
        success: false,
        error: `图片标注失败: ${message}`,
      };
    }
  },
};
