// ============================================================================
// L1: Tool Result Budget — per-result token cap with head+tail truncation
// ============================================================================
// Runs on every message before it enters the transcript.
// Tool results (role='tool' or has toolCallId) are truncated to maxTokensPerResult.
// Preserves the first code block if present.
// Mutates message.content directly (pre-transcript, not API-view mutation).
// ============================================================================

import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';
import { spillToolResult, buildSpillNotice } from '../../utils/toolResultSpill';

export interface ToolResultBudgetConfig {
  maxTokensPerResult: number; // default: 2000
  protectedMessageIds?: Set<string>;
  /**
   * GAP-009: 提供 sessionId 时，超预算的工具结果先落盘再截断，
   * 截断文本尾部附加路径提示，模型可用 Read/Grep 回查完整输出。
   * 不提供则保持纯截断（兼容旧行为 / 测试）。
   */
  spillSessionId?: string;
}

const DEFAULT_CONFIG: Pick<ToolResultBudgetConfig, 'maxTokensPerResult'> = {
  maxTokensPerResult: 2000,
};

// G24: 错误信号行的正则。head+tail 截断会丢掉夹在中段的关键报错行
// （stack trace / 编译错误 / 断言失败），模型看不到失败原因就反复重试 (stagnation)。
// 截断时这些行优先保留，即使它们落在被丢弃的中段。
// 模式刻意偏宽松：漏判一行真错误 → stagnation；误判多留一行 → 只是稍微占点预算。
// 所以不用 \b 词边界（否则 AssertionError / TypeError 这类会漏）。
const KEY_LINE_PATTERNS: RegExp[] = [
  /error/i,                    // error, Error, AssertionError, error TS2345 ...
  /exception/i,
  /\bfail/i,                   // fail, failed, failure, FAIL, Failed
  /panic/i,
  /traceback/i,
  /fatal/i,
  /assert/i,                   // assert, assertion, AssertionError
  /^\s+at\s/,                  // JS stack frame
  /^\s+File\s"/,               // Python stack frame
  /\b(ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b/,
  /not found|cannot find|is not (defined|a function)|undefined is not/i,
  /[✗✘❌⛔]/,
];

/**
 * 从一组行里挑出匹配错误信号的行，最多取 maxTokens 预算。
 */
function extractKeyLines(lines: string[], maxTokens: number): string[] {
  if (maxTokens <= 0) return [];
  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    if (!KEY_LINE_PATTERNS.some((re) => re.test(line))) continue;
    const lt = estimateTokens(line) + 1;
    if (tokens + lt > maxTokens) break;
    kept.push(line);
    tokens += lt;
  }
  return kept;
}

/**
 * Extract the first code block from text if present.
 * Returns { pre, block, post } or null if no code block found.
 */
function extractFirstCodeBlock(
  text: string,
): { pre: string; block: string; post: string } | null {
  const match = text.match(/^([\s\S]*?)(```[\s\S]*?```)([\s\S]*)$/);
  if (!match) return null;
  return { pre: match[1], block: match[2], post: match[3] };
}

/**
 * Truncate text to fit within maxTokens using head+tail strategy.
 * If a code block is found, it is preserved at the head.
 */
function truncateHeadTail(text: string, maxTokens: number): string {
  const codeBlockResult = extractFirstCodeBlock(text);

  if (codeBlockResult) {
    // Keep code block, distribute remaining budget between head and tail
    const { pre, block, post } = codeBlockResult;
    const blockTokens = estimateTokens(block);
    const preTokens = estimateTokens(pre);

    // If code block alone exceeds budget, truncate the code block itself
    if (blockTokens >= maxTokens) {
      return truncatePlain(block, maxTokens);
    }

    // Budget remaining after the code block and separator
    const separatorTokens = 10; // for "...[truncated]..." markers
    const remainingBudget = maxTokens - blockTokens - separatorTokens;

    if (remainingBudget <= 0) {
      return block;
    }

    // Allocate evenly between pre and post
    const halfBudget = Math.floor(remainingBudget / 2);
    const preKept = preTokens <= halfBudget ? pre : truncatePlain(pre, halfBudget);
    const postBudget = remainingBudget - estimateTokens(preKept);
    const postKept = post.length > 0 ? truncateTail(post, postBudget) : '';

    return [preKept, block, postKept].filter(Boolean).join('');
  }

  return truncatePlain(text, maxTokens);
}

/**
 * Truncate keeping head + key error lines from the dropped middle + tail.
 * Budget split: head ~40% / key middle lines ~20% / tail ~40%.
 * G24: if the dropped middle contains error signals (stack traces, compiler
 * errors, assertion failures), they are preserved so the model can still
 * diagnose the failure instead of looping. No error signals → plain head+tail.
 */
function truncatePlain(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) return text;

  const lines = text.split('\n');
  const keyBudget = Math.floor(maxTokens * 0.2);
  const sideBudget = Math.floor((maxTokens - keyBudget) / 2);

  // Take lines from head
  const headLines: string[] = [];
  let headTokens = 0;
  let headEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const lt = estimateTokens(lines[i]) + 1; // +1 for newline
    if (headTokens + lt > sideBudget) break;
    headLines.push(lines[i]);
    headTokens += lt;
    headEnd = i + 1;
  }

  // Take lines from tail — start from headEnd so head and tail never overlap
  const tailLines: string[] = [];
  let tailTokens = 0;
  let tailStart = lines.length;
  for (let i = lines.length - 1; i >= headEnd; i--) {
    const lt = estimateTokens(lines[i]) + 1;
    if (tailTokens + lt > sideBudget) break;
    tailLines.unshift(lines[i]);
    tailTokens += lt;
    tailStart = i;
  }

  // Scan the dropped middle for key error lines
  const keyLines = extractKeyLines(lines.slice(headEnd, tailStart), keyBudget);

  if (keyLines.length === 0) {
    return headLines.join('\n') + '\n...[truncated]...\n' + tailLines.join('\n');
  }
  return (
    headLines.join('\n')
    + `\n...[truncated, ${keyLines.length} key line(s) preserved]...\n`
    + keyLines.join('\n')
    + '\n...[truncated]...\n'
    + tailLines.join('\n')
  );
}

/**
 * Truncate keeping the tail (for post-code-block content).
 */
function truncateTail(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) return text;

  const lines = text.split('\n');
  const tailLines: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lt = estimateTokens(lines[i]) + 1;
    if (tailTokens + lt > maxTokens) break;
    tailLines.unshift(lines[i]);
    tailTokens += lt;
  }
  return '...\n' + tailLines.join('\n');
}

/**
 * Apply token budget to tool result messages.
 * Mutates message.content directly.
 * Writes a commit per truncated message.
 */
export function applyToolResultBudget(
  messages: Array<{ id: string; role: string; content: string; toolCallId?: string }>,
  state: CompressionState,
  config?: Partial<ToolResultBudgetConfig>,
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const alreadyBudgeted = state.getSnapshot().budgetedResults;

  for (const msg of messages) {
    const isToolResult = msg.role === 'tool' || msg.toolCallId !== undefined;
    if (!isToolResult) continue;
    if (cfg.protectedMessageIds?.has(msg.id)) continue;

    const originalTokens = estimateTokens(msg.content);
    if (originalTokens <= cfg.maxTokensPerResult) continue;

    // 管线每轮拿到的是从原始 transcript 重建的全文副本，state 跨轮复用。
    // 已 budgeted 的消息必须幂等重截断（否则次轮全文回流 API view），
    // 只对 commit 去重，避免 commitLog 逐轮膨胀。
    const wasBudgeted = alreadyBudgeted.has(msg.id);

    // GAP-009: 截断前落盘完整输出（已带落盘提示的内容会被 spillToolResult 跳过，防止二次落盘）
    const spillPath = cfg.spillSessionId !== undefined
      ? spillToolResult({
          content: msg.content,
          toolName: 'tool-result',
          sessionId: cfg.spillSessionId,
          toolCallId: msg.toolCallId || msg.id,
        })
      : null;

    const truncated = truncateHeadTail(msg.content, cfg.maxTokensPerResult);
    const truncatedTokens = estimateTokens(truncated);

    // Mutate the message content
    msg.content = spillPath ? truncated + buildSpillNotice(spillPath) : truncated;

    // Record the commit (once per message — re-truncations reuse the original commit)
    if (wasBudgeted) continue;
    state.applyCommit({
      layer: 'tool-result-budget',
      operation: 'truncate',
      targetMessageIds: [msg.id],
      timestamp: Date.now(),
      metadata: { originalTokens, truncatedTokens },
    });
  }
}
