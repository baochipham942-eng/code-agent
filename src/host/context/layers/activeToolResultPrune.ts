// ============================================================================
// L0: Active Tool Result Prune — deterministic full-body archive
// ============================================================================
// Runs before L1 (tool-result-budget). Results whose token count exceeds
// maxTokensPerResult are archived to disk in full and their message content
// is replaced wholesale with a deterministic placeholder — same content
// always produces the same placeholder bytes, so results that would
// otherwise drift each round under L1's lossy head+tail truncation instead
// stay byte-stable across pipeline re-evaluations, keeping the provider
// prompt cache prefix intact.
// Mutates message.content directly (pre-transcript, not API-view mutation).
// ============================================================================

import { CompressionState } from '../compressionState';
import { estimateTokens } from '../tokenEstimator';
import { spillToolResultArchive, SPILL_NOTICE_MARKER } from '../../utils/toolResultSpill';

export interface ActiveToolResultPruneConfig {
  enabled: boolean;
  maxTokensPerResult: number;
  protectedMessageIds?: Set<string>;
  spillSessionId?: string;
}

/** 占位符固定标识前缀：识别已处理过的消息，防止对自己产出的占位符二次归档 */
export const ACTIVE_PRUNE_PLACEHOLDER_MARKER = '[TOOL_RESULT_ARCHIVED]';

/**
 * 构造确定性占位符：只依赖 toolName/originalTokens/archiveRef/preview，
 * 不含时间戳或随机数，同输入必产同字节。
 */
function buildPlaceholder(params: {
  toolName: string;
  originalTokens: number;
  bytes: number;
  sha256: string;
  filePath: string;
  preview: string;
}): string {
  const { toolName, originalTokens, bytes, sha256, filePath, preview } = params;
  return [
    `${ACTIVE_PRUNE_PLACEHOLDER_MARKER} ${toolName} 的完整输出已归档（未截断、可完整取回）。`,
    `original: ~${originalTokens} tokens / ${bytes} bytes, sha256 ${sha256.slice(0, 12)}`,
    `archive: ${filePath}`,
    '取回方式：用 Read 工具读上面的 archive 路径（大文件用 offset/limit 分页），或用 Grep 在该文件里检索关键内容。若结果里提到源文件路径，编辑前先 Read 源文件本身。',
    'preview（前 200 字符）:',
    preview,
  ].join('\n');
}

/**
 * 对超预算工具结果整体归档 + 换占位符。
 * 幂等：管线每轮都从原始 transcript 重建全文副本并重新调用本函数，
 * 所以每轮都要重新替换 content；只有第一次遇到某条消息才写 commit
 * （复用 state.budgetedResults 语义，与 L1 的 wasBudgeted 模式一致——
 * L0 处理过的消息 token 数已降到阈值以下，L1 天然跳过，不会双重计账）。
 *
 * @returns 本次调用实际替换了内容的消息数（用于管线判断是否 push 'active-prune'）
 */
export function applyActiveToolResultPrune(
  messages: Array<{ id: string; role: string; content: string; toolCallId?: string; [key: string]: unknown }>,
  state: CompressionState,
  config: ActiveToolResultPruneConfig,
): number {
  if (!config.enabled) return 0;

  const alreadyPruned = state.getSnapshot().budgetedResults;
  let prunedCount = 0;

  for (const msg of messages) {
    const isToolResult = msg.role === 'tool' || msg.toolCallId !== undefined;
    if (!isToolResult) continue;
    if (config.protectedMessageIds?.has(msg.id)) continue;
    // 已带落盘提示（其他截断点已归档过）或已是本层占位符，跳过防二次处理
    if (msg.content.includes(SPILL_NOTICE_MARKER)) continue;
    if (msg.content.startsWith(ACTIVE_PRUNE_PLACEHOLDER_MARKER)) continue;

    const originalTokens = estimateTokens(msg.content);
    if (originalTokens <= config.maxTokensPerResult) continue;

    const toolName = typeof msg.toolName === 'string' ? msg.toolName : 'tool-result';
    const spillResult = spillToolResultArchive({
      content: msg.content,
      toolName,
      sessionId: config.spillSessionId,
      // toolCallId 缺省回退 msg.id：保证同消息每轮落盘路径稳定，绝不落到 Date.now() 兜底分支
      toolCallId: msg.toolCallId || msg.id,
      sourceMessageId: msg.id,
      reason: 'active-prune',
    });

    // 无损原则：落盘失败就保留原文不动，交给下游 L1 做有损截断兜底
    if (!spillResult) continue;

    const wasPruned = alreadyPruned.has(msg.id);
    const placeholder = buildPlaceholder({
      toolName,
      originalTokens,
      bytes: spillResult.archiveRef.bytes,
      sha256: spillResult.archiveRef.sha256,
      filePath: spillResult.filePath,
      preview: msg.content.slice(0, 200),
    });

    msg.content = placeholder;
    prunedCount++;

    if (wasPruned) continue;
    state.applyCommit({
      layer: 'active-prune',
      operation: 'truncate',
      targetMessageIds: [msg.id],
      timestamp: Date.now(),
      metadata: {
        originalTokens,
        placeholderTokens: estimateTokens(placeholder),
        archiveRef: spillResult.archiveRef,
      },
    });
  }

  return prunedCount;
}
