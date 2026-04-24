// ============================================================================
// visual_edit (Mode A) — vision-grounded end-to-end code edit
// ============================================================================
// Live Preview 点击 → 源码定位 → 视觉 LLM 产 diff → 原子写入文件。
//
// 设计要点：
// - 走 canUseTool 权限门（permissionLevel: 'write'），UI 层弹 diff 预览
// - 路径逃逸防护：目标文件必须位于 ctx.workingDir 之下
// - 视觉 LLM 用智谱 GLM-4.6V（本地 API Key）— 只有本地直连这一条路，
//   失败不 fallback 到云端代理/OpenRouter，避免 visual_edit 的推理决策被
//   不可追踪的第三方转发链影响。API Key 缺失时明确报错。
// - 模型输出必须是严格 JSON {old_text, new_text, summary}；解析失败 = 工具失败
// - old_text 必须在文件中**精确且唯一**命中，否则拒绝写入（避免歧义替换）
// - atomicWriteFile 原子落盘（temp + rename），进程崩溃不会损坏原文件
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import {
  VISUAL_EDIT_MODEL_TEXT,
  VISUAL_EDIT_MODEL_VISION,
  MODEL_API_ENDPOINTS,
  MODEL_MAX_TOKENS,
} from '../../../../shared/constants';

/** 按调用形态选模型：有 screenshot 走 vision model，否则走 text model。
 *  env override: VISUAL_EDIT_MODEL_TEXT / VISUAL_EDIT_MODEL_VISION */
function pickVisualEditModel(hasScreenshot: boolean): string {
  if (hasScreenshot) {
    return process.env.VISUAL_EDIT_MODEL_VISION || VISUAL_EDIT_MODEL_VISION;
  }
  return process.env.VISUAL_EDIT_MODEL_TEXT || VISUAL_EDIT_MODEL_TEXT;
}
import { getConfigService } from '../../../services';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { visualEditSchema as schema } from './visualEdit.schema';

interface VisualEditArgs {
  file?: string;
  line?: number;
  column?: number;
  componentName?: string;
  tag?: string;
  text?: string;
  userIntent?: string;
  screenshotBase64?: string;
  screenshotMimeType?: string;
  contextRadius?: number;
}

interface VisionDiffPlan {
  old_text: string;
  new_text: string;
  summary: string;
}

interface VisualEditOutput {
  absolutePath: string;
  line: number;
  column: number;
  applied: true;
  summary: string;
  oldText: string;
  newText: string;
  bytesDelta: number;
  visionModel: string;
}

const DEFAULT_RADIUS = 10;
const MAX_RADIUS = 40;
const VISION_TIMEOUT_MS = 60_000;

function formatWithLineNumbers(lines: string[], startLine: number): string {
  const endLine = startLine + lines.length - 1;
  const width = Math.max(4, String(endLine).length);
  return lines
    .map((content, idx) => {
      const lineNo = String(startLine + idx).padStart(width, ' ');
      return `${lineNo}\t${content}`;
    })
    .join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle.length) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/** 从模型返回里抽出严格的 JSON 对象（可能被 ```json 包裹） */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // 先尝试直接 parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fallthrough */
  }
  // 剥掉 ```json ... ``` 外壳
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  // 最后尝试：第一个 { 到最后一个 } 的切片
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* noop */
    }
  }
  throw new Error('模型输出不是合法 JSON');
}

function isDiffPlan(v: unknown): v is VisionDiffPlan {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.old_text === 'string' && typeof o.new_text === 'string' && typeof o.summary === 'string';
}

const SYSTEM_PROMPT = [
  '你是一个代码视觉编辑助手。用户在 Live Preview 中点选了一个渲染好的 UI 元素，',
  '并用自然语言描述了想要的改动。你的任务是在提供的源码片段（surrounding_code）中',
  '找到对应的 JSX / CSS / className 片段，产出**最小化**的替换方案。',
  '',
  '硬性约束：',
  '1. 输出**必须**是严格 JSON，形如 {"old_text": "...", "new_text": "...", "summary": "..."}',
  '2. old_text 必须从 surrounding_code 中逐字 copy（不包含行号前缀和 tab）',
  '3. old_text 必须覆盖足够的上下文，保证在整个源文件中**唯一命中**',
  '4. new_text 保持原有缩进和风格，只改用户意图要求的部分',
  '5. summary 用一句话总结改动（中文）',
  '6. 禁止输出除 JSON 之外的任何解释文本',
].join('\n');

function buildUserContent(args: {
  sourceContext: string;
  selected: VisualEditArgs;
  hasScreenshot: boolean;
}): string {
  const { sourceContext, selected, hasScreenshot } = args;
  const selectedLines = [
    `file: ${selected.file}`,
    `line:column: ${selected.line}:${selected.column ?? 1}`,
    selected.componentName ? `componentName: ${selected.componentName}` : null,
    selected.tag ? `tag: ${selected.tag}` : null,
    selected.text ? `visibleText: ${JSON.stringify(selected.text)}` : null,
  ].filter(Boolean).join('\n');

  return [
    hasScreenshot ? '下方图片是用户点击时 iframe 的截图；选中的元素由 LocatorJS 定位。' : '（本轮无截图，仅基于源码 + 意图推理）',
    '',
    'selected_element:',
    selectedLines,
    '',
    'user_intent:',
    selected.userIntent ?? '',
    '',
    'surrounding_code (带行号，**不要把行号前缀 copy 进 old_text**):',
    '```',
    sourceContext,
    '```',
    '',
    '按系统消息要求输出严格 JSON。',
  ].join('\n');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callZhipuVision(args: {
  apiKey: string;
  userContent: string;
  screenshotBase64?: string;
  screenshotMimeType?: string;
}): Promise<{ content: string; model: string }> {
  const { apiKey, userContent, screenshotBase64, screenshotMimeType } = args;
  const hasScreenshot = !!screenshotBase64;
  const model = pickVisualEditModel(hasScreenshot);
  const contentParts: unknown[] = [{ type: 'text', text: userContent }];
  if (hasScreenshot) {
    const mime = screenshotMimeType || 'image/png';
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${screenshotBase64}` },
    });
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: contentParts },
    ],
    max_tokens: MODEL_MAX_TOKENS.VISION,
    temperature: 0.2,
  };

  const response = await fetchWithTimeout(
    `${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    VISION_TIMEOUT_MS,
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`智谱视觉 API ${response.status}: ${errText.slice(0, 500)}`);
  }
  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = result.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('智谱视觉 API 返回空内容');
  return { content, model };
}

class VisualEditHandler implements ToolHandler<VisualEditArgs, VisualEditOutput> {
  readonly schema = schema;

  async execute(
    args: VisualEditArgs,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<VisualEditOutput>> {
    const rawFile = args.file;
    const line = args.line;
    const userIntent = (args.userIntent ?? '').trim();

    if (!rawFile || typeof rawFile !== 'string') {
      return { ok: false, error: 'file 必须是字符串路径', code: 'INVALID_ARGS' };
    }
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) {
      return { ok: false, error: 'line 必须是正整数', code: 'INVALID_ARGS' };
    }
    if (!userIntent) {
      return { ok: false, error: 'userIntent 不能为空', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args as Record<string, unknown>);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    // 路径规范化 + 逃逸防护
    const workingRoot = path.resolve(ctx.workingDir);
    const absolutePath = path.isAbsolute(rawFile) ? path.resolve(rawFile) : path.resolve(workingRoot, rawFile);
    const rel = path.relative(workingRoot, absolutePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: `文件 ${absolutePath} 位于项目外`, code: 'PATH_ESCAPE' };
    }

    onProgress?.({ stage: 'starting', detail: `reading ${path.basename(absolutePath)}:${line}` });

    let raw: string;
    try {
      raw = await fs.readFile(absolutePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `读取源文件失败：${msg}`, code: 'READ_FAILED' };
    }

    const allLines = raw.split('\n');
    const totalLines = allLines.length;
    if (line > totalLines) {
      return {
        ok: false,
        error: `line ${line} 超过文件总行数 ${totalLines}`,
        code: 'LINE_OUT_OF_RANGE',
      };
    }

    const radius = Math.min(MAX_RADIUS, Math.max(1, Math.floor(args.contextRadius ?? DEFAULT_RADIUS)));
    const contextStart = Math.max(1, line - radius);
    const contextEnd = Math.min(totalLines, line + radius);
    const sourceContext = formatWithLineNumbers(
      allLines.slice(contextStart - 1, contextEnd),
      contextStart,
    );

    // 调视觉 LLM
    const configService = getConfigService();
    const zhipuApiKey = configService?.getApiKey('zhipu');
    if (!zhipuApiKey) {
      return {
        ok: false,
        error: 'ZHIPU_API_KEY 未配置，visual_edit 无法调用视觉模型。请在设置中配置智谱 Key。',
        code: 'MISSING_API_KEY',
      };
    }

    onProgress?.({
      stage: 'running',
      detail: args.screenshotBase64 ? '调用视觉模型（含截图）' : '调用视觉模型（纯文本）',
    });

    const userContent = buildUserContent({
      sourceContext,
      selected: args,
      hasScreenshot: !!args.screenshotBase64,
    });

    let llmRaw: string;
    let llmModel: string;
    try {
      const callResult = await callZhipuVision({
        apiKey: zhipuApiKey,
        userContent,
        screenshotBase64: args.screenshotBase64,
        screenshotMimeType: args.screenshotMimeType,
      });
      llmRaw = callResult.content;
      llmModel = callResult.model;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `视觉模型调用失败：${msg}`, code: 'VISION_FAILED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    // 解析 diff plan
    let plan: VisionDiffPlan;
    try {
      const parsed = extractJson(llmRaw);
      if (!isDiffPlan(parsed)) throw new Error('JSON 结构不符合 {old_text, new_text, summary}');
      plan = parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `模型输出解析失败：${msg}\n原始输出前 500 字：${llmRaw.slice(0, 500)}`,
        code: 'PARSE_FAILED',
      };
    }

    if (!plan.old_text.length) {
      return { ok: false, error: '模型返回的 old_text 为空', code: 'INVALID_PLAN' };
    }
    if (plan.old_text === plan.new_text) {
      return { ok: false, error: 'old_text 与 new_text 相同，无实际改动', code: 'NOOP_PLAN' };
    }

    // 精确命中 + 唯一性校验
    const occurrences = countOccurrences(raw, plan.old_text);
    if (occurrences === 0) {
      return {
        ok: false,
        error: `old_text 在文件中找不到精确匹配。模型可能漏拷贝了缩进或换行——请重试或让用户提供更具体的描述。\n模型 summary: ${plan.summary}`,
        code: 'OLD_TEXT_NOT_FOUND',
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        error: `old_text 在文件中命中 ${occurrences} 次（要求唯一）。模型需要扩大上下文避免歧义。\n模型 summary: ${plan.summary}`,
        code: 'OLD_TEXT_AMBIGUOUS',
      };
    }

    // 原子写入
    onProgress?.({ stage: 'completing', detail: '应用改动' });
    const next = raw.replace(plan.old_text, plan.new_text);
    try {
      await atomicWriteFile(absolutePath, next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `写入文件失败：${msg}`, code: 'WRITE_FAILED' };
    }

    const bytesDelta = Buffer.byteLength(next, 'utf-8') - Buffer.byteLength(raw, 'utf-8');

    ctx.logger.info('visual_edit applied', {
      absolutePath,
      line,
      bytesDelta,
      summary: plan.summary,
      hasScreenshot: !!args.screenshotBase64,
    });

    return {
      ok: true,
      output: {
        absolutePath,
        line,
        column: Math.max(1, Math.floor(args.column ?? 1)),
        applied: true,
        summary: plan.summary,
        oldText: plan.old_text,
        newText: plan.new_text,
        bytesDelta,
        visionModel: llmModel,
      },
    };
  }
}

export const visualEditModule: ToolModule<VisualEditArgs, VisualEditOutput> = {
  schema,
  createHandler() {
    return new VisualEditHandler();
  },
};
