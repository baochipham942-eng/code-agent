import type { Message } from '../../../../shared/contract';
import type { ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import { compactModelSummarize } from '../../../context/compactModel';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from '../contextAssembly';
import { logger } from '../contextAssembly';
import {
  formatArtifactRepairToolResultContent,
  getAllowedArtifactRepairToolCallIds,
  getArtifactRepairTargetFile,
  isArtifactRepairMode,
  resolveArtifactRepairPath,
} from './artifactRepairProjection';

export function buildContextTranscriptEntries(ctx: ContextAssemblyCtx, messages: Message[]): ContextTranscriptEntry[] {
  const artifactRepairMode = isArtifactRepairMode(ctx);
  const allowedArtifactRepairToolCallIds = artifactRepairMode
    ? getAllowedArtifactRepairToolCallIds(ctx, messages)
    : null;
  let turnIndex = 0;
  let hasSeenUserTurn = false;
  const entries: ContextTranscriptEntry[] = [];

  for (const message of messages) {
    if (message.role === 'user' && hasSeenUserTurn) {
      turnIndex += 1;
    }
    if (message.role === 'user') {
      hasSeenUserTurn = true;
    }

    const baseEntry = {
      originMessageId: message.id,
      timestamp: message.timestamp,
      turnIndex,
    };

    if (message.role === 'tool' && message.toolResults?.length) {
      entries.push(
        ...message.toolResults
          .filter((result) => {
            if (!allowedArtifactRepairToolCallIds) return true;
            if (!result.toolCallId) return true;
            const targetFile = getArtifactRepairTargetFile(ctx);
            const resultFilePath = typeof result.metadata?.filePath === 'string'
              ? result.metadata.filePath
              : null;
            if (result.metadata?.evidenceKind === 'file_read' && resultFilePath) {
              if (!targetFile) return false;
              return resolveArtifactRepairPath(ctx, resultFilePath) === targetFile && result.success === true;
            }
            const isTargetFileRead =
              result.metadata?.evidenceKind === 'file_read' &&
              resultFilePath &&
              targetFile &&
              resolveArtifactRepairPath(ctx, resultFilePath) === targetFile &&
              result.success === true;
            if (isTargetFileRead) return true;
            return allowedArtifactRepairToolCallIds.has(result.toolCallId);
          })
          .map((result, index) => ({
            ...baseEntry,
            id: `${message.id}::tool-result::${result.toolCallId || index}`,
            role: 'tool',
            content: artifactRepairMode
              ? formatArtifactRepairToolResultContent(ctx, result, result.output || result.error || '')
              : (result.output || result.error || ''),
            toolCallId: result.toolCallId,
            toolError: !result.success,
            preserveObservation: result.metadata?.preserveObservation === true,
            evidenceKind: typeof result.metadata?.evidenceKind === 'string' ? result.metadata.evidenceKind : undefined,
            filePath: typeof result.metadata?.filePath === 'string' ? result.metadata.filePath : undefined,
          })),
      );
      continue;
    }

    entries.push({
      ...baseEntry,
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
    });
  }

  return entries;
}

export function mapInterventionsToTranscriptEntries(
  _ctx: ContextAssemblyCtx,
  interventions: ContextInterventionSnapshot,
  entries: ContextTranscriptEntry[],
): ContextInterventionSnapshot {
  const entryIdsByOriginMessageId = new Map<string, string[]>();
  for (const entry of entries) {
    const entryIds = entryIdsByOriginMessageId.get(entry.originMessageId) || [];
    entryIds.push(entry.id);
    entryIdsByOriginMessageId.set(entry.originMessageId, entryIds);
  }

  const expandIds = (ids: string[]): string[] => {
    const expanded = new Set<string>();
    for (const id of ids) {
      const mappedIds = entryIdsByOriginMessageId.get(id);
      if (mappedIds && mappedIds.length > 0) {
        for (const mappedId of mappedIds) {
          expanded.add(mappedId);
        }
      } else {
        expanded.add(id);
      }
    }
    return Array.from(expanded);
  };

  return {
    pinned: expandIds(interventions.pinned),
    excluded: expandIds(interventions.excluded),
    retained: expandIds(interventions.retained),
  };
}

export async function summarizeCollapsedContext(
  _ctx: ContextAssemblyCtx,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const prompt = [
    '请将下面这段运行上下文压缩成一段简洁摘要。',
    '要求：保留关键结论、文件路径、工具结果、失败原因和后续待办；不要编造；尽量控制在 200 tokens 内。',
    '',
    '上下文片段：',
    ...messages.map((message) => `[${message.role}] ${message.content}`),
  ].join('\n');

  try {
    return (await compactModelSummarize(prompt, 200)).trim();
  } catch (error) {
    logger.warn('[ContextAssembly] Context collapse summarization failed, using heuristic fallback', error);
    return messages
      .map((message) => `[${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`)
      .join(' | ')
      .slice(0, 1000);
  }
}

export function stripInternalFormatMimicry(_ctx: ContextAssemblyCtx, content: string): string {
  if (!content) return content;
  let cleaned = content;
  // Remove "Ran: <command>" lines (model mimicking formatToolCallForHistory output)
  cleaned = cleaned.replace(/^Ran:\s+.+$/gm, '');
  // Remove "Tool results:" lines
  cleaned = cleaned.replace(/^Tool results:\s*$/gm, '');
  // Remove "[Compressed tool results: ...]" lines
  cleaned = cleaned.replace(/^\[Compressed tool results:.*?\]\s*$/gm, '');
  // Remove "<checkpoint-nudge ...>...</checkpoint-nudge>" blocks
  cleaned = cleaned.replace(/<checkpoint-nudge[^>]*>[\s\S]*?<\/checkpoint-nudge>/g, '');
  // Remove "<truncation-recovery>...</truncation-recovery>" blocks
  cleaned = cleaned.replace(/<truncation-recovery>[\s\S]*?<\/truncation-recovery>/g, '');
  // Collapse excessive blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

export function detectTaskPatterns(ctx: ContextAssemblyCtx, userMessage: string): string[] {
  const hints: string[] = [];

  // 异常检测任务 — 防止输出全部行
  if (/异常|anomal|outlier|离群/i.test(userMessage)) {
    hints.push(
      '【异常检测】输出文件只包含被标记为异常的行，不要输出全部数据。' +
      '使用 IQR 或 Z-score 方法检测，异常标记列用数值 0/1 或布尔值（不要用中文"是"/"否"字符串）。'
    );
  }

  // 透视表 + 交叉分析 — 防止遗漏子任务
  if (/透视|pivot|交叉分析/i.test(userMessage)) {
    hints.push(
      '【透视分析】此类任务通常包含多个子任务，务必逐项完成：' +
      '① 透视表 ② 排名/Top N ③ 增长率计算 ④ 图表 ⑤ 品类/分类占比数据。' +
      '每个子任务的结果保存为独立的 sheet 或文件。完成后对照检查是否有遗漏。'
    );
  }

  // 多轮迭代任务 — 防止上下文丢失
  if (ctx.runtime.messages.length > 10) {
    hints.push(
      '【多轮任务】这是多轮迭代任务。请先用 bash ls 检查输出目录中已有的文件，' +
      '在已有文件基础上修改，不要从头重建。图表修改请先读取数据源再重新生成。'
    );
  }

  return hints;
}

export function getCurrentAttachments(ctx: ContextAssemblyCtx): Array<{
  type: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
}> {
  for (let i = ctx.runtime.messages.length - 1; i >= 0; i--) {
    const msg = ctx.runtime.messages[i];
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      return msg.attachments.map(att => ({
        type: att.type,
        category: att.category,
        name: att.name,
        path: att.path,
        data: att.data,
        mimeType: att.mimeType,
      }));
    }
  }
  return [];
}
