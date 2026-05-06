// ============================================================================
// image_process (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy ImageProcessTool 迁移到 native：sharp 图像处理（convert/compress/
// resize/upscale）+ 4 输出格式 + 输出路径管理。
//
// abort signal 走 race-and-abandon：sharp 是 node binding 不是 spawn，但
// sharp.toFile() 返回 Promise，用 race-and-abandon 与 ctx.abortSignal 联动。
//
// 行为保真：legacy 中文文案、emoji（🖼️ 📥 📤 📦 📄）、metadata.attachment
// （id 前缀 image-、category=image）1:1 复刻。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { formatFileSize } from '../../utils/fileSize';
import { imageProcessSchema as schema } from './imageProcess.schema';

const SUPPORTED_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tiff'];

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

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.message === 'aborted';
}

export async function executeImageProcess(
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

  const params = args as unknown as ImageProcessParams;
  const { input_path, action } = params;

  if (typeof input_path !== 'string' || input_path.length === 0) {
    return { ok: false, error: 'input_path is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (!['convert', 'compress', 'resize', 'upscale'].includes(action)) {
    return { ok: false, error: `Invalid action: ${action}`, code: 'INVALID_ARGS' };
  }

  const quality = params.quality ?? 80;
  const scale = params.scale ?? 2;

  try {
    const absInputPath = path.isAbsolute(input_path)
      ? input_path
      : path.join(ctx.workingDir, input_path);

    if (!fs.existsSync(absInputPath)) {
      return { ok: false, error: `文件不存在: ${absInputPath}`, code: 'FS_ERROR' };
    }

    const inputExt = path.extname(absInputPath).toLowerCase().slice(1);
    if (!SUPPORTED_FORMATS.includes(inputExt)) {
      return {
        ok: false,
        error: `不支持的输入格式: ${inputExt}，支持: ${SUPPORTED_FORMATS.join(', ')}`,
        code: 'INVALID_ARGS',
      };
    }

    const metadata = await withAbort(sharp(absInputPath).metadata(), ctx.abortSignal);
    const originalSize = fs.statSync(absInputPath).size;

    ctx.emit({
      type: 'tool_output',
      tool: 'image_process',
      message: `🖼️ 处理中: ${path.basename(absInputPath)} (${metadata.width}x${metadata.height})`,
    } as never);

    let image = sharp(absInputPath);
    let outputFormat: string = params.format || inputExt;
    let actionDescription = '';

    switch (action) {
      case 'convert':
        if (!params.format) {
          return { ok: false, error: '格式转换需要指定 format 参数', code: 'INVALID_ARGS' };
        }
        actionDescription = `格式转换 → ${params.format.toUpperCase()}`;
        break;

      case 'compress':
        actionDescription = `压缩 (质量: ${quality}%)`;
        break;

      case 'resize':
        if (!params.width && !params.height) {
          return { ok: false, error: '缩放需要指定 width 或 height', code: 'INVALID_ARGS' };
        }
        image = image.resize(params.width, params.height, {
          fit: 'inside',
          withoutEnlargement: true,
        });
        actionDescription = `缩放 → ${params.width || 'auto'}x${params.height || 'auto'}`;
        break;

      case 'upscale': {
        if (!metadata.width || !metadata.height) {
          return { ok: false, error: '无法读取图片尺寸', code: 'IMAGE_ERROR' };
        }
        const newWidth = Math.round(metadata.width * scale);
        const newHeight = Math.round(metadata.height * scale);
        image = image.resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
        });
        actionDescription = `放大 ${scale}x → ${newWidth}x${newHeight}`;
        break;
      }
    }

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

    const inputBaseName = path.basename(absInputPath, path.extname(absInputPath));
    const outputFileName = `${inputBaseName}_${action}.${outputFormat}`;
    const outputDir = params.output_path
      ? path.dirname(params.output_path)
      : ctx.workingDir;
    const finalPath = params.output_path || path.join(outputDir, outputFileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    await withAbort(image.toFile(finalPath), ctx.abortSignal);

    const outputStats = fs.statSync(finalPath);
    const outputMetadata = await withAbort(sharp(finalPath).metadata(), ctx.abortSignal);
    const compressionRatio = ((1 - outputStats.size / originalSize) * 100).toFixed(1);

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('image_process done', {
      action,
      input: absInputPath,
      output: finalPath,
      originalSize,
      newSize: outputStats.size,
    });

    return {
      ok: true,
      output: `✅ 图片处理完成！

🖼️ 操作: ${actionDescription}
📥 输入: ${path.basename(absInputPath)} (${metadata.width}x${metadata.height})
📤 输出: ${path.basename(finalPath)} (${outputMetadata.width}x${outputMetadata.height})
📦 原始大小: ${formatFileSize(originalSize)}
📦 处理后: ${formatFileSize(outputStats.size)} (${compressionRatio}% ${Number(compressionRatio) > 0 ? '减少' : '增加'})
📄 文件: ${finalPath}

点击上方路径可直接打开。`,
      meta: {
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
    if (isAbortError(error) || ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('image_process failed', { error: message });
    return { ok: false, error: `图片处理失败: ${message}` };
  }
}

class ImageProcessHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeImageProcess(args, ctx, canUseTool, onProgress);
  }
}

export const imageProcessModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ImageProcessHandler();
  },
};
