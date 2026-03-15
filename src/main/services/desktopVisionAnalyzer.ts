// ============================================================================
// DesktopVisionAnalyzer - 后台截图视觉分析（类 StepFun analyze_text）
// 轮询未分析的截图，调用视觉模型生成语义描述
// ============================================================================

import fs from 'fs';
import { execFileSync } from 'child_process';
import { createLogger } from './infra/logger';
import { getConfigService } from './index';
import { getNativeDesktopService } from './nativeDesktopService';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS } from '../../shared/constants';

const logger = createLogger('DesktopVisionAnalyzer');

const ANALYZE_PROMPT = '用一段话简要描述截图中用户正在做什么，包括应用界面的关键内容（文字、代码、表格数据等）。不要分析情绪，只描述事实。';
const ANALYZE_INTERVAL_MS = 30_000; // 每 30 秒检查一次
const ANALYZE_TIMEOUT_MS = 20_000;
const MAX_BATCH = 3; // 每轮最多分析 3 张

let analyzerTimer: ReturnType<typeof setInterval> | null = null;
let analyzing = false;

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

async function analyzeScreenshot(imagePath: string): Promise<string | null> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');
  if (!zhipuApiKey) return null;

  if (!fs.existsSync(imagePath)) {
    logger.warn('[视觉分析] 截图文件不存在', { imagePath });
    return null;
  }

  const imageData = fs.readFileSync(imagePath);
  const ext = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'jpeg' : 'png';
  const base64Image = imageData.toString('base64');

  const requestBody = {
    model: ZHIPU_VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: ANALYZE_PROMPT },
          {
            type: 'image_url',
            image_url: { url: `data:image/${ext};base64,${base64Image}` },
          },
        ],
      },
    ],
    max_tokens: 512,
  };

  const response = await fetchWithTimeout(
    `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zhipuApiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    ANALYZE_TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.warn('[视觉分析] API 失败', { status: response.status, error: errorText.slice(0, 200) });
    return null;
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || null;
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
    const service = getNativeDesktopService();
    const status = service.getStatus();
    const sqlitePath = status.sqliteDbPath;
    if (!sqlitePath || !fs.existsSync(sqlitePath)) return;

    const configService = getConfigService();
    const zhipuApiKey = configService.getApiKey('zhipu');
    if (!zhipuApiKey) return;

    const pending = findPendingEvents(sqlitePath, MAX_BATCH);
    if (pending.length === 0) return;

    logger.info(`[视觉分析] 发现 ${pending.length} 张待分析截图`);

    for (const event of pending) {
      try {
        const text = await analyzeScreenshot(event.screenshot_path);
        if (text) {
          updateAnalyzeText(sqlitePath, event.id, text);
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
    logger.warn('[视觉分析] 循环异常', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    analyzing = false;
  }
}

export function startDesktopVisionAnalyzer(): void {
  if (analyzerTimer) return;
  logger.info('[视觉分析] 启动后台分析器');
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
