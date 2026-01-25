// ============================================================================
// Image Annotate Tool - 图片理解与标注
// 使用智谱视觉模型理解图片内容，并在图片上进行标记
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ImageAnnotate');

// 配置
const CONFIG = {
  ZHIPU_MODEL: 'glm-4.6v-flash',
  ZHIPU_API_URL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  TIMEOUT_MS: 60000,
  SUPPORTED_FORMATS: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  MAX_IMAGE_SIZE_MB: 20,
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
}

interface AnnotationResult {
  description: string;
  regions: AnnotationRegion[];
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
 * 调用智谱视觉模型分析图片并获取标注区域
 */
async function analyzeAndGetAnnotations(
  apiKey: string,
  base64Image: string,
  mimeType: string,
  query: string
): Promise<AnnotationResult> {
  const systemPrompt = `你是一个图片分析专家。用户会上传图片并提问，请：
1. 分析图片内容，回答用户问题
2. 如果用户要求标记某个元素，请以 JSON 格式返回该元素的位置信息

位置信息格式：
\`\`\`json
{
  "regions": [
    {
      "type": "circle",  // circle, rectangle, arrow, highlight
      "x": 100,          // 中心点 x 坐标 (像素)
      "y": 200,          // 中心点 y 坐标 (像素)
      "radius": 50,      // 圆形半径 (像素)
      "label": "按钮"    // 标签文字
    }
  ]
}
\`\`\`

坐标估算规则：
- x, y 坐标从图片左上角开始，向右、向下为正
- 根据图片比例和元素位置估算大致坐标
- 如果无法准确定位，给出合理的估算值

请先用自然语言描述图片内容和目标位置，然后在描述结尾附上 JSON 标注信息。`;

  const requestBody = {
    model: CONFIG.ZHIPU_MODEL,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: query },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: 2048,
  };

  logger.info('[图片标注] 调用智谱视觉模型', { query });

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
  const content = result.choices?.[0]?.message?.content || '';

  // 解析响应，提取描述和 JSON 标注
  return parseAnnotationResponse(content);
}

/**
 * 解析模型响应，提取描述和标注区域
 */
function parseAnnotationResponse(content: string): AnnotationResult {
  let description = content;
  let regions: AnnotationRegion[] = [];

  // 尝试提取 JSON 块
  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const jsonData = JSON.parse(jsonMatch[1]);
      if (jsonData.regions && Array.isArray(jsonData.regions)) {
        regions = jsonData.regions;
      }
      // 移除 JSON 块，保留描述部分
      description = content.replace(/```json\s*[\s\S]*?\s*```/, '').trim();
    } catch (e) {
      logger.warn('[图片标注] JSON 解析失败', { error: (e as Error).message });
    }
  }

  return { description, regions };
}

/**
 * 使用 Canvas 在图片上绘制标注
 * 由于 Electron 环境没有原生 Canvas，使用 sharp 库处理
 */
async function drawAnnotations(
  imagePath: string,
  regions: AnnotationRegion[],
  outputPath: string
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
  const width = metadata.width || 800;
  const height = metadata.height || 600;

  // 构建 SVG 覆盖层
  let svgOverlay = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;

  for (const region of regions) {
    const color = region.color || '#FF0000';
    const strokeWidth = Math.max(3, Math.min(width, height) / 150); // 自适应线宽

    switch (region.type) {
      case 'circle':
        svgOverlay += `
          <circle
            cx="${region.x}"
            cy="${region.y}"
            r="${region.radius || 30}"
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
            height="${region.height || 100}"
            fill="none"
            stroke="${color}"
            stroke-width="${strokeWidth}"
          />`;
        break;

      case 'arrow':
        const endX = region.endX || region.x + 50;
        const endY = region.endY || region.y;
        const arrowSize = strokeWidth * 3;
        // 计算箭头方向
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

      case 'text':
        // 文字标签
        break;
    }

    // 添加标签
    if (region.label) {
      const fontSize = Math.max(14, Math.min(width, height) / 40);
      const labelY = region.type === 'circle'
        ? region.y - (region.radius || 30) - 10
        : region.y - 10;
      svgOverlay += `
        <text
          x="${region.x}"
          y="${labelY}"
          fill="${color}"
          font-size="${fontSize}"
          font-family="Arial, sans-serif"
          text-anchor="middle"
          font-weight="bold"
        >${escapeXml(region.label)}</text>`;
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
  };
  return mimeTypes[ext] || 'image/png';
}

interface ImageAnnotateParams {
  image_path: string;
  query: string;
  output_path?: string;
  draw_annotations?: boolean;
}

export const imageAnnotateTool: Tool = {
  name: 'image_annotate',
  description: `图片理解与标注工具。

分析图片内容，回答问题，并可在图片上标记指定元素（如圈出按钮、标记组件）。

参数：
- image_path: 图片文件路径（必填）
- query: 分析问题或标注指令（必填）
  - 例如："圈出登录按钮"、"标记所有导航链接"、"这个界面有哪些组件？"
- output_path: 标注后的图片保存路径（可选）
- draw_annotations: 是否绘制标注（默认 true）

支持格式：${CONFIG.SUPPORTED_FORMATS.join(', ')}
限制：最大 ${CONFIG.MAX_IMAGE_SIZE_MB}MB

示例：
\`\`\`
image_annotate { "image_path": "screenshot.png", "query": "圈出提交按钮" }
image_annotate { "image_path": "ui.png", "query": "标记所有输入框", "output_path": "annotated.png" }
image_annotate { "image_path": "design.png", "query": "这个界面的布局是什么样的？", "draw_annotations": false }
\`\`\`

注意：需要配置智谱 API Key`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
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
      const zhipuApiKey = configService.getApiKey('zhipu');

      if (!zhipuApiKey) {
        return {
          success: false,
          error: '图片标注需要配置智谱 API Key。请在设置中添加智谱 API Key。',
        };
      }

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
        message: '🔍 正在分析图片...',
      });

      // 读取图片并转 base64
      const imageData = fs.readFileSync(imagePath);
      const base64Image = imageData.toString('base64');
      const mimeType = getMimeType(imagePath);

      // 分析图片并获取标注
      const result = await analyzeAndGetAnnotations(
        zhipuApiKey,
        base64Image,
        mimeType,
        typedParams.query
      );

      let output = `📝 分析结果:\n${result.description}`;
      let annotatedPath: string | undefined;

      // 如果有标注区域且需要绘制
      const shouldDraw = typedParams.draw_annotations !== false;
      if (shouldDraw && result.regions.length > 0) {
        context.emit?.('tool_output', {
          tool: 'image_annotate',
          message: `🖍️ 正在绘制 ${result.regions.length} 个标注...`,
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
        await drawAnnotations(imagePath, result.regions, annotatedPath);

        output += `\n\n📍 标注区域: ${result.regions.length} 个`;
        output += `\n📄 标注图片: ${annotatedPath}`;
      } else if (result.regions.length === 0 && shouldDraw) {
        output += '\n\n⚠️ 未能识别到需要标注的区域';
      }

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        output,
        metadata: {
          imagePath,
          annotatedPath,
          description: result.description,
          regions: result.regions,
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
    } catch (error: any) {
      logger.error('[图片标注] 失败', { error: error.message });
      return {
        success: false,
        error: `图片标注失败: ${error.message}`,
      };
    }
  },
};
