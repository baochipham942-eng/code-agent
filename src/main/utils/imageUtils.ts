// ============================================================================
// Image Utilities - 图片数据处理工具函数
// 用于规范化图片数据格式，确保在多 Agent 编排中正确传递
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ImageUtils');

/**
 * 规范化后的图片数据
 */
export interface NormalizedImageData {
  /** 纯 base64 字符串（不含 data URL 前缀） */
  base64: string;
  /** MIME 类型 */
  mimeType: string;
  /** 原始文件路径（如果有） */
  path?: string;
}

/**
 * 图片附件输入类型
 */
export interface ImageAttachmentInput {
  type?: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
}

/**
 * 根据文件路径推断 MIME 类型
 */
export function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
  };
  return mimeTypes[ext] || 'image/png';
}

/**
 * 检查字符串是否是有效的 base64
 */
export function isValidBase64(str: string): boolean {
  if (!str || str.length === 0) return false;
  // 检查是否只包含 base64 合法字符
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(str);
}

/**
 * 规范化图片数据
 *
 * 输入可能是：
 * 1. 纯 base64 字符串
 * 2. data URL (data:image/png;base64,xxx)
 * 3. 文件路径（需要读取文件）
 *
 * 输出统一为：
 * { base64: string, mimeType: string, path?: string }
 *
 * @param data - 图片数据（base64 或 data URL）
 * @param filePath - 图片文件路径
 * @param mimeType - 明确指定的 MIME 类型
 * @returns 规范化后的图片数据，如果无法处理则返回 null
 */
export function normalizeImageData(
  data?: string,
  filePath?: string,
  mimeType?: string
): NormalizedImageData | null {
  // 1. 如果有 data 字段
  if (data && data.length > 0) {
    // 1.1 检查是否是 data URL
    if (data.startsWith('data:')) {
      const match = data.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        logger.debug('Parsed data URL', { mimeType: match[1], dataLength: match[2].length });
        return {
          base64: match[2],
          mimeType: match[1],
          path: filePath,
        };
      }
      // data URL 格式错误，尝试其他解析
      logger.warn('Invalid data URL format, trying alternative parsing');
    }

    // 1.2 检查是否是纯 base64
    // 注意：base64 字符串可能很长，这里只检查前 100 个字符
    const sampleData = data.substring(0, 100);
    if (isValidBase64(sampleData)) {
      logger.debug('Using raw base64 data', { dataLength: data.length });
      return {
        base64: data,
        mimeType: mimeType || (filePath ? getMimeTypeFromPath(filePath) : 'image/png'),
        path: filePath,
      };
    }

    // 1.3 data 字段不是有效的图片数据
    logger.warn('Data field is not valid base64 or data URL');
  }

  // 2. 如果有 path 字段，尝试从文件读取
  if (filePath) {
    try {
      // 解析相对路径
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

      if (fs.existsSync(resolvedPath)) {
        const buffer = fs.readFileSync(resolvedPath);
        const base64 = buffer.toString('base64');
        const detectedMime = mimeType || getMimeTypeFromPath(resolvedPath);

        logger.debug('Loaded image from file', {
          path: resolvedPath,
          size: buffer.length,
          mimeType: detectedMime,
        });

        return {
          base64,
          mimeType: detectedMime,
          path: resolvedPath,
        };
      } else {
        logger.warn('Image file not found', { path: resolvedPath });
      }
    } catch (error) {
      logger.error('Failed to read image file', {
        path: filePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return null;
}

/**
 * 批量规范化图片附件
 *
 * @param attachments - 图片附件数组
 * @returns 规范化后的图片数据数组（过滤掉无法处理的）
 */
export function normalizeImageAttachments(
  attachments: ImageAttachmentInput[]
): NormalizedImageData[] {
  const results: NormalizedImageData[] = [];

  for (const att of attachments) {
    // 只处理图片类型
    if (att.type !== 'image' && att.category !== 'image') {
      continue;
    }

    const normalized = normalizeImageData(att.data, att.path, att.mimeType);
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

/**
 * 构建多模态消息内容中的图片部分
 * 用于发送给支持视觉的模型
 *
 * @param imageData - 规范化后的图片数据
 * @returns 符合 API 格式的图片内容对象
 */
export function buildImageMessageContent(imageData: NormalizedImageData): {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
} {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: imageData.mimeType,
      data: imageData.base64,
    },
  };
}

/**
 * 从多种格式的附件中提取图片路径
 * 用于需要文件路径的工具（如 image_annotate）
 *
 * @param attachments - 附件数组
 * @returns 图片文件路径数组
 */
export function extractImagePaths(attachments: ImageAttachmentInput[]): string[] {
  const paths: string[] = [];

  for (const att of attachments) {
    if ((att.type === 'image' || att.category === 'image') && att.path) {
      paths.push(att.path);
    }
  }

  return paths;
}
