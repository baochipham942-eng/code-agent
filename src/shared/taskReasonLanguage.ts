// ============================================================================
// 任务证据的语义化翻译层（ADR-050 依赖 A）
//
// blockedReason / completionEvidence 最终要展示给非程序员协作者。模型经常直接把
// raw error（stack trace / JSON 响应体 / "AxiosError: Request failed with status
// code 403"）塞进来，这层负责：
//   1. 把机器噪音剥掉，只留能读的散文；
//   2. 用已有的 ErrorClassifier 推断语义类别，让 UI 用自己的 i18n 文案兜底，
//      而不是把英文报错原样怼到用户脸上。
// 原始文本不丢——它进 session_task_events 的 summary 供排错。
//
// 住在 shared/ 而不是 host/：run 卡片与 tool 卡片的阻塞原因在 renderer 侧投影时
// 才拿到（runWorkbenchProjection），和任务轨走同一套清洗才不会一边说人话一边贴
// stack trace。本文件无 host 依赖，只用 shared 的类型。
// ============================================================================

import type { TaskBlockedCategory } from './contract/planning';

/** 展示用文本上限：一行提示的量级，超出说明模型在贴日志 */
const MAX_DISPLAY_LENGTH = 160;

/** 机器噪音特征：命中任意一条就认为这段不是写给人看的 */
const MACHINE_NOISE_PATTERNS: RegExp[] = [
  /^\s*[{[]/,                       // JSON / 数组响应体
  /\bat\s+[\w$.<>]+\s*\([^)]*:\d+:\d+\)/, // stack frame
  /^\s*at\s+\S+:\d+:\d+/m,
  /\b[A-Z][\w.]*Error\b:/,          // TypeError: / AxiosError:
  /\b(?:E[A-Z]{3,}|ERR_[A-Z_]+)\b/, // ECONNREFUSED / ERR_BAD_REQUEST
  /\bTraceback \(most recent call last\)/,
  /\bstatus\s*code\s*\d{3}\b/i,
  /<\/?[a-z]+[^>]*>/i,              // HTML 片段
];

function looksMachineGenerated(text: string): boolean {
  return MACHINE_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function truncate(text: string): string {
  return text.length <= MAX_DISPLAY_LENGTH
    ? text
    : `${text.slice(0, MAX_DISPLAY_LENGTH - 1).trimEnd()}…`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 类别识别只认英文机器特征——中文散文原因会落到 unknown，正是我们想要的：
 * 认不出来就别猜，保留模型自己的话。
 *
 * 没有复用 src/host/errors/errorClassifier.ts：那整个 errors/ 模块目前是死代码
 * （knip unused files），为了一次类别查表把 484 行无人维护的模式表拖进活引用图
 * 不划算。这里只需要展示层用得上的这几类。
 */
const CATEGORY_PATTERNS: Array<[TaskBlockedCategory, RegExp]> = [
  ['rate_limit', /\b429\b|rate.?limit|too many requests|quota/i],
  ['permission', /\b40[13]\b|forbidden|unauthorized|permission denied|access denied|EACCES|requires? (?:a )?(?:login|sign.?in)/i],
  ['resource', /\b404\b|not found|ENOENT|no such file/i],
  ['network', /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|getaddrinfo|fetch failed|network error|timed? ?out/i],
  ['model', /context length|content policy|model (?:not available|overloaded)/i],
  ['tool', /tool (?:not found|failed)|command not found|exit code [1-9]/i],
];

function toBlockedCategory(raw: string): TaskBlockedCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(raw)) return category;
  }
  return 'unknown';
}

export interface TaskBlockedReasonDescription {
  /** 可直接展示的说明；模型贴的是纯日志时为空串，由 UI 用 category 文案兜底 */
  reason: string;
  category: TaskBlockedCategory;
}

/**
 * 把 agent 写的阻塞原因翻成可展示的说明 + 语义类别。
 */
export function describeTaskBlockedReason(raw: string): TaskBlockedReasonDescription {
  const normalized = collapseWhitespace(raw);
  const category = toBlockedCategory(normalized);
  return {
    reason: looksMachineGenerated(normalized) ? '' : truncate(normalized),
    category,
  };
}

/**
 * 完成证据同样会出现在交接摘要/任务详情里，做同样的噪音清洗。
 * 与阻塞原因不同的是这里不丢弃内容——证据本身就可能是命令输出，
 * 只压缩空白并截断，保证不把整屏日志灌进账本。
 */
export function sanitizeTaskEvidenceText(raw: string): string {
  return truncate(collapseWhitespace(raw));
}
