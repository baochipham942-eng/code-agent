// ============================================================================
// Image Process Tool - 图片处理工具
// 支持格式转换、压缩、缩放
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { createLogger } from '../../services/infra/logger';
import { formatFileSize } from '../utils/fileSize';

const logger = createLogger('ImageProcess');

interface ImageProcessParams {
  input_path: string;
  action: 'convert' | 'compress' | 'resize' | 'upscale';
  output_path?: string;
  format?: 'png' | 'jpg' | 'webp' | 'avif' | 'gif';
  quality?: number;
  width?: number;
  height?: number;
  scale?: number;
}

/**
 * 获取支持的格式
 */
const SUPPORTED_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tiff'];

export const imageProcessTool: Tool = {
  name: 'image_process',
  description: `图片处理工具，支持格式转换、压缩、缩放。

**操作类型：**
- convert: 格式转换（PNG/JPG/WebP/AVIF/GIF）
- compress: 无损或有损压缩
- resize: 缩放到指定尺寸
- upscale: 放大图片（使用 Lanczos 算法）

**使用示例：**

格式转换：
\`\`\`
image_process { "input_path": "photo.png", "action": "convert", "format": "webp" }
\`\`\`

图片压缩：
\`\`\`
image_process { "input_path": "photo.jpg", "action": "compress", "quality": 80 }
\`\`\`

缩放图片：
\`\`\`
image_process { "input_path": "photo.png", "action": "resize", "width": 800, "height": 600 }
\`\`\`

放大图片（2倍）：
\`\`\`
image_process { "input_path": "icon.png", "action": "upscale", "scale": 2 }
\`\`\``,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      input_path: {
        type: 'string',
        description: '输入图片路径',
      },
      action: {
        type: 'string',
        enum: ['convert', 'compress', 'resize', 'upscale'],
        description: '操作类型',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 自动生成）',
      },
      format: {
        type: 'string',
        enum: ['png', 'jpg', 'webp', 'avif', 'gif'],
        description: '输出格式（convert 操作必填）',
      },
      quality: {
        type: 'number',
        description: '压缩质量 1-100（默认: 80）',
        default: 80,
      },
      width: {
        type: 'number',
        description: '目标宽度（resize 操作）',
      },
      height: {
        type: 'number',
        description: '目标高度（resize 操作）',
      },
      scale: {
        type: 'number',
        description: '放大倍数（upscale 操作，默认: 2）',
        default: 2,
      },
    },
    required: ['input_path', 'action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      input_path,
      action,
      output_path,
      format,
      quality = 80,
      width,
      height,
      scale = 2,
    } = params as unknown as ImageProcessParams;

    try {
      // 解析输入路径
      const absInputPath = path.isAbsolute(input_path)
        ? input_path
        : path.join(context.workingDirectory, input_path);

      // 检查文件存在
      if (!fs.existsSync(absInputPath)) {
        return {
          success: false,
          error: `文件不存在: ${absInputPath}`,
        };
      }

      // 检查格式
      const inputExt = path.extname(absInputPath).toLowerCase().slice(1);
      if (!SUPPORTED_FORMATS.includes(inputExt)) {
        return {
          success: false,
          error: `不支持的输入格式: ${inputExt}，支持: ${SUPPORTED_FORMATS.join(', ')}`,
        };
      }

      // 获取原始图片信息
      const metadata = await sharp(absInputPath).metadata();
      const originalSize = fs.statSync(absInputPath).size;

      context.emit?.('tool_output', {
        tool: 'image_process',
        message: `🖼️ 处理中: ${path.basename(absInputPath)} (${metadata.width}x${metadata.height})`,
      });

      let image = sharp(absInputPath);
      let outputFormat = format || inputExt;
      let actionDescription = '';

      switch (action) {
        case 'convert':
          if (!format) {
            return {
              success: false,
              error: '格式转换需要指定 format 参数',
            };
          }
          actionDescription = `格式转换 → ${format.toUpperCase()}`;
          break;

        case 'compress':
          actionDescription = `压缩 (质量: ${quality}%)`;
          break;

        case 'resize':
          if (!width && !height) {
            return {
              success: false,
              error: '缩放需要指定 width 或 height',
            };
          }
          image = image.resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          });
          actionDescription = `缩放 → ${width || 'auto'}x${height || 'auto'}`;
          break;

        case 'upscale':
          if (!metadata.width || !metadata.height) {
            return {
              success: false,
              error: '无法读取图片尺寸',
            };
          }
          const newWidth = Math.round(metadata.width * scale);
          const newHeight = Math.round(metadata.height * scale);
          image = image.resize(newWidth, newHeight, {
            kernel: sharp.kernel.lanczos3,
          });
          actionDescription = `放大 ${scale}x → ${newWidth}x${newHeight}`;
          break;
      }

      // 应用输出格式和质量
      switch (outputFormat) {
        case 'jpg':
        case 'jpeg':
          image = image.jpeg({ quality, mozjpeg: true });
          outputFormat = 'jpg';
          break;
        case 'png':
          image = image.png({ compressionLevel: 9 });
          break;
        case 'webp':
          image = image.webp({ quality });
          break;
        case 'avif':
          image = image.avif({ quality });
          break;
        case 'gif':
          image = image.gif();
          break;
      }

      // 确定输出路径
      const inputBaseName = path.basename(absInputPath, path.extname(absInputPath));
      const outputFileName = `${inputBaseName}_${action}.${outputFormat}`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, outputFileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 保存文件
      await image.toFile(finalPath);

      const outputStats = fs.statSync(finalPath);
      const outputMetadata = await sharp(finalPath).metadata();
      const compressionRatio = ((1 - outputStats.size / originalSize) * 100).toFixed(1);

      logger.info('Image processed', {
        action,
        input: absInputPath,
        output: finalPath,
        originalSize,
        newSize: outputStats.size,
      });

      return {
        success: true,
        output: `✅ 图片处理完成！

🖼️ 操作: ${actionDescription}
📥 输入: ${path.basename(absInputPath)} (${metadata.width}x${metadata.height})
📤 输出: ${path.basename(finalPath)} (${outputMetadata.width}x${outputMetadata.height})
📦 原始大小: ${formatFileSize(originalSize)}
📦 处理后: ${formatFileSize(outputStats.size)} (${compressionRatio}% ${Number(compressionRatio) > 0 ? '减少' : '增加'})
📄 文件: ${finalPath}

点击上方路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: outputStats.size,
          originalSize,
          width: outputMetadata.width,
          height: outputMetadata.height,
          format: outputFormat,
          action,
          compressionRatio: Number(compressionRatio),
          attachment: {
            id: `image-${Date.now()}`,
            type: 'file',
            category: 'image',
            name: path.basename(finalPath),
            path: finalPath,
            size: outputStats.size,
            mimeType: `image/${outputFormat === 'jpg' ? 'jpeg' : outputFormat}`,
          },
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Image processing failed', { error: message });
      return {
        success: false,
        error: `图片处理失败: ${message}`,
      };
    }
  },
};
