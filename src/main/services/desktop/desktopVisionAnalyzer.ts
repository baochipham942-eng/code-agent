// ============================================================================
// DesktopVisionAnalyzer - 后台截图视觉分析（完全离线，Ollama 本地模型）
// 轮询未分析的截图，调用本地 Qwen3-VL 生成语义描述
// ============================================================================

import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createLogger } from '../infra/logger';
import { getNativeDesktopService } from './nativeDesktopService';

const logger = createLogger('DesktopVisionAnalyzer');

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'qwen3-vl:2b';
const ANALYZE_PROMPT = `简要描述截图中用户正在做什么。要求：
- **当前操作**：用一句话概括用户正在进行的活动
- **关键内容**：列出界面中可见的关键信息（标题、代码片段、表格数据、URL 等），每项一行
- **窗口布局**：简述可见的应用窗口

只描述事实，不要分析情绪，不要输出思考过程。用中文回答。`;
const ANALYZE_INTERVAL_MS = 30_000; // 每 30 秒检查一次
const ANALYZE_TIMEOUT_MS = 60_000; // 本地模型推理较慢，给 60 秒
const MAX_BATCH = 3; // 每轮最多分析 3 张

let analyzerTimer: ReturnType<typeof setInterval> | null = null;
let analyzing = false;
let ollamaAvailable: boolean | null = null; // 缓存可用性检查

// --- 截图去重：文件哈希 + 最近已分析文本复用 ---
let lastAnalyzedHash: string | null = null;
let lastAnalyzedText: string | null = null;
let duplicateSkipCount = 0;

/** 计算截图文件的 MD5 哈希（快速去重，非安全用途） */
function computeFileHash(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET' }, 3000);
    if (!resp.ok) return false;
    const data = await resp.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];
    const hasModel = models.some((m) => m.name.startsWith('qwen3-vl'));
    if (!hasModel) {
      logger.warn(`[视觉分析] Ollama 运行中但未找到 ${OLLAMA_MODEL}，请运行: ollama pull ${OLLAMA_MODEL}`);
    }
    return hasModel;
  } catch {
    return false;
  }
}

async function analyzeScreenshot(imagePath: string): Promise<string | null> {
  if (!fs.existsSync(imagePath)) {
    logger.warn('[视觉分析] 截图文件不存在', { imagePath });
    return null;
  }

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');

  const requestBody = {
    model: OLLAMA_MODEL,
    messages: [
      {
        role: 'user',
        content: ANALYZE_PROMPT,
        images: [base64Image],
      },
    ],
    stream: false,
    options: {
      num_predict: 512,
    },
  };

  const response = await fetchWithTimeout(
    `${OLLAMA_BASE_URL}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
    ANALYZE_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.warn('[视觉分析] Ollama 调用失败', { status: response.status, error: errorText.slice(0, 200) });
    return null;
  }

  const result = await response.json() as { message?: { content?: string } };
  const content = result.message?.content;
  if (!content) return null;

  // 去除 Qwen3 可能输出的 <think>...</think> 标签
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

interface PendingEvent {
  id: string;
  screenshot_path: string;
}

function findPendingEvents(sqlitePath: string, limit: number): PendingEvent[] {
  if (!fs.existsSync(sqlitePath)) return [];

  try {
    const sql = `SELECT id, screenshot_path FROM desktop_activity_events WHERE screenshot_path IS NOT NULL AND (analyze_text IS NULL OR analyze_text = '') ORDER BY captured_at_ms DESC LIMIT ${limit};`;
    const output = execFileSync('sqlite3', ['-json', sqlitePath, sql], {
      encoding: 'utf-8',
    }).trim();
    if (!output) return [];
    return JSON.parse(output) as PendingEvent[];
  } catch {
    return [];
  }
}

function updateAnalyzeText(sqlitePath: string, eventId: string, analyzeText: string): void {
  const sql = `UPDATE desktop_activity_events SET analyze_text = '${sqlEscape(analyzeText)}', raw_json = json_set(raw_json, '$.analyzeText', '${sqlEscape(analyzeText)}') WHERE id = '${sqlEscape(eventId)}';`;
  execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' });
}

async function runAnalysisCycle(): Promise<void> {
  if (analyzing) return;
  analyzing = true;

  try {
    // 检查 Ollama 可用性（首次或上次不可用时重新检查）
    if (ollamaAvailable !== true) {
      ollamaAvailable = await checkOllamaAvailable();
      if (!ollamaAvailable) return;
      logger.info('[视觉分析] Ollama 本地模型就绪');
    }

    const service = getNativeDesktopService();
    const status = service.getStatus();
    const sqlitePath = status.sqliteDbPath;
    if (!sqlitePath || !fs.existsSync(sqlitePath)) return;

    const pending = findPendingEvents(sqlitePath, MAX_BATCH);
    if (pending.length === 0) return;

    logger.info(`[视觉分析] 发现 ${pending.length} 张待分析截图（本地 ${OLLAMA_MODEL}）`);

    for (const event of pending) {
      try {
        // 截图哈希去重：内容相同则复用上次分析结果，跳过 Ollama 调用
        const hash = computeFileHash(event.screenshot_path);
        if (hash && hash === lastAnalyzedHash && lastAnalyzedText) {
          updateAnalyzeText(sqlitePath, event.id, lastAnalyzedText);
          duplicateSkipCount++;
          if (duplicateSkipCount % 10 === 1) {
            logger.info('[视觉分析] 截图内容未变化，复用上次结果', { skipped: duplicateSkipCount });
          }
          continue;
        }

        const text = await analyzeScreenshot(event.screenshot_path);
        if (text) {
          updateAnalyzeText(sqlitePath, event.id, text);
          lastAnalyzedHash = hash;
          lastAnalyzedText = text;
          duplicateSkipCount = 0;
          logger.info('[视觉分析] 完成', { eventId: event.id, textLength: text.length });
        }
      } catch (error) {
        logger.warn('[视觉分析] 单张分析失败', {
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    // Ollama 可能中途停止
    ollamaAvailable = null;
    logger.warn('[视觉分析] 循环异常', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    analyzing = false;
  }
}

export function startDesktopVisionAnalyzer(): void {
  if (analyzerTimer) return;
  logger.info('[视觉分析] 启动后台分析器（Ollama 本地模式）');
  analyzerTimer = setInterval(runAnalysisCycle, ANALYZE_INTERVAL_MS);
  // 延迟 10 秒后跑第一轮，等采集器先写入几条
  setTimeout(runAnalysisCycle, 10_000);
}

export function stopDesktopVisionAnalyzer(): void {
  if (analyzerTimer) {
    clearInterval(analyzerTimer);
    analyzerTimer = null;
    logger.info('[视觉分析] 停止后台分析器');
  }
}
