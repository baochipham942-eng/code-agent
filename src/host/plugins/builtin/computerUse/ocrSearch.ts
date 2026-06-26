// ============================================================================
// ocr_search (Vision Framework OCR — native ToolModule)
//
// 调用 macOS Vision Framework 的 vision-ocr binary 做 OCR，结果可选入库
// 到 memories 表（type='ocr_result'）便于后续按文字搜索历史截图。
//
// binary 路径解析与 system-audio-capture 同形态（dev / Tauri Resources）。
// ============================================================================

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getDatabase } from '../../../services/core/databaseService';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';
import { ocrSearchSchema as schema } from './ocrSearch.schema';

const BINARY_NAME = 'vision-ocr';
const DEFAULT_LANGUAGES = ['zh-Hans', 'zh-Hant', 'en-US'];
const EXEC_TIMEOUT_MS = 60_000;

interface OcrRegion {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

interface OcrSwiftOutput {
  ok: boolean;
  path: string;
  error?: string;
  details?: string;
  fullText?: string;
  regions?: OcrRegion[];
  imageSize?: { width: number; height: number };
  languages?: string[];
}

interface OcrOutput {
  fullText: string;
  regions: OcrRegion[];
  imageSize: { width: number; height: number };
  memoryId?: string;
}

let cachedBinaryPath: string | null = null;

function findVisionOcrBinary(): string | null {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) return cachedBinaryPath;

  const candidates: string[] = [];
  // 1. dev：scripts/ 目录
  candidates.push(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', '..', 'scripts', BINARY_NAME));
  // 2. Tauri 打包：Resources/_up_/scripts/ 或 Resources/scripts/
  candidates.push(path.join(__dirname, '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', 'scripts', BINARY_NAME));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        cachedBinaryPath = candidate;
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function runVisionOcr(
  binary: string,
  imagePath: string,
  languages: string[],
  abortSignal: AbortSignal,
): Promise<OcrSwiftOutput> {
  return new Promise((resolve) => {
    const args = ['--photo', imagePath, '--languages', languages.join(',')];
    const child = execFile(
      binary,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (abortSignal.aborted) {
          resolve({ ok: false, path: imagePath, error: 'aborted' });
          return;
        }
        if (err) {
          try {
            const parsed = JSON.parse(stdout) as OcrSwiftOutput;
            if (!parsed.ok) {
              resolve(parsed);
              return;
            }
          } catch {
            // not JSON, fallthrough
          }
          const parsedError = stderr.trim() || err.message;
          resolve({ ok: false, path: imagePath, error: parsedError });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as OcrSwiftOutput;
          resolve(parsed);
        } catch (parseErr) {
          resolve({
            ok: false,
            path: imagePath,
            error: 'invalid_json_output',
            details: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
        }
      },
    );

    if (abortSignal.aborted) {
      child.kill('SIGTERM');
      return;
    }
    const onAbort = () => {
      child.kill('SIGTERM');
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    child.once('close', () => abortSignal.removeEventListener('abort', onAbort));
  });
}

function persistOcrToMemory(
  imagePath: string,
  result: OcrSwiftOutput,
  ctx: ToolContext,
): string | undefined {
  try {
    const db = getDatabase();
    const fullTextRaw = result.fullText || '';
    const regionsRaw = result.regions || [];
    // OCR 截图内容入本地 memories 表前过 sensitiveDataGuard：
    // surface='memory' / mode='local-persist' 启用 secret/token/SSN/credit-card
    // 等规则脱敏 + prompt injection neutralize,挡住密码框/Token 截图被后续 LLM 调用
    // 当成上下文上云。summary 必须基于 guard 后的 fullText 切片,不能用 raw。
    const fullText = guardSensitiveText(fullTextRaw, {
      surface: 'memory',
      mode: 'local-persist',
      maxLength: 100_000,
      preserveLines: true,
    });
    const regions: OcrRegion[] = regionsRaw.map((r) => ({
      ...r,
      text: guardSensitiveText(r.text, {
        surface: 'memory',
        mode: 'local-persist',
        maxLength: 4_000,
      }),
    }));
    const memory = db.createMemory({
      type: 'ocr_result',
      category: 'screenshot_ocr',
      content: fullText,
      summary: fullText.slice(0, 200),
      source: 'auto_learned',
      sessionId: ctx.sessionId,
      confidence: regions.length > 0
        ? regions.reduce((sum, r) => sum + r.confidence, 0) / regions.length
        : 0,
      metadata: {
        imagePath,
        imageSize: result.imageSize,
        languages: result.languages || DEFAULT_LANGUAGES,
        regionCount: regions.length,
        ocrMethod: 'vision_framework',
        regions,
      },
    });
    return memory.id;
  } catch (err) {
    ctx.logger.warn('ocr_search: failed to persist memory', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

class OcrSearchHandler implements ToolHandler<Record<string, unknown>, OcrOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    _canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<OcrOutput>> {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'ocr_search 仅支持 macOS（依赖 Vision Framework）',
        code: 'PLATFORM_UNSUPPORTED',
      };
    }

    const imagePathRaw = args.imagePath;
    if (typeof imagePathRaw !== 'string' || imagePathRaw.length === 0) {
      return { ok: false, error: 'imagePath 必填且必须是字符串', code: 'INVALID_ARGS' };
    }
    const imagePath = path.resolve(imagePathRaw);
    if (!fs.existsSync(imagePath)) {
      return { ok: false, error: `图片不存在: ${imagePath}`, code: 'FILE_NOT_FOUND' };
    }

    const languagesRaw = args.languages;
    let languages = DEFAULT_LANGUAGES;
    if (Array.isArray(languagesRaw) && languagesRaw.length > 0) {
      languages = languagesRaw.filter((v): v is string => typeof v === 'string');
      if (languages.length === 0) languages = DEFAULT_LANGUAGES;
    }
    const persist = args.persist !== false;

    const binary = findVisionOcrBinary();
    if (!binary) {
      return {
        ok: false,
        error: 'vision-ocr binary 未找到。请运行 scripts/build-vision-ocr.sh 编译',
        code: 'BINARY_NOT_FOUND',
      };
    }

    onProgress?.({ stage: 'running', detail: `OCR ${path.basename(imagePath)}...` });

    const result = await runVisionOcr(binary, imagePath, languages, ctx.abortSignal);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || 'OCR 失败',
        code: 'OCR_FAILED',
        meta: { details: result.details, imagePath },
      };
    }

    const fullText = result.fullText || '';
    const regions = result.regions || [];
    const imageSize = result.imageSize || { width: 0, height: 0 };

    let memoryId: string | undefined;
    if (persist && fullText.length > 0) {
      memoryId = persistOcrToMemory(imagePath, result, ctx);
    }

    onProgress?.({ stage: 'completing', detail: `识别 ${regions.length} 个文本块` });

    return {
      ok: true,
      output: { fullText, regions, imageSize, memoryId },
      meta: {
        method: 'vision_framework',
        imagePath,
        regionCount: regions.length,
        languages,
        memoryPersisted: Boolean(memoryId),
      },
    };
  }
}

export const ocrSearchModule: ToolModule<Record<string, unknown>, OcrOutput> = {
  schema,
  createHandler() {
    return new OcrSearchHandler();
  },
};
