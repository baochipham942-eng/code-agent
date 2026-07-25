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
// ============================================================================

import type { TaskBlockedCategory } from '../../../shared/contract/planning';
import { getErrorClassifier } from '../../errors/errorClassifier';

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

function toBlockedCategory(raw: string): TaskBlockedCategory {
  // ErrorClassifier 的 category 枚举与 TaskBlockedCategory 同名同义，直接透传。
  // 它的模式是英文的，中文散文原因会落到 unknown——正是我们想要的：
  // 认不出来就别猜，保留模型自己的话。
  return getErrorClassifier().classify(raw).category;
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
