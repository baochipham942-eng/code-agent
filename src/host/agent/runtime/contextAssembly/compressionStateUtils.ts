// ============================================================================
// 压缩缓存键与压缩状态克隆（从 messageBuild.ts 拆出，控制单文件行数）
// ============================================================================

import { createHash } from 'crypto';
import type { ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import { CompressionState } from '../../../context/compressionState';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from './shared';

export function buildCompressionCacheKey(
  ctx: ContextAssemblyCtx,
  entries: ContextTranscriptEntry[],
  interventions: ContextInterventionSnapshot,
  contextWindowSize: number,
): string {
  const hash = createHash('sha256');
  hash.update(ctx.runtime.sessionId);
  hash.update('\u0000');
  hash.update(ctx.runtime.agentId || '');
  hash.update('\u0000');
  hash.update(String(contextWindowSize));
  hash.update('\u0000');
  hash.update(JSON.stringify(interventions));
  for (const entry of entries) {
    hash.update('\u0000');
    hash.update(entry.id);
    hash.update('\u0001');
    hash.update(entry.originMessageId);
    hash.update('\u0001');
    hash.update(entry.role);
    hash.update('\u0001');
    hash.update(String(entry.timestamp));
    hash.update('\u0001');
    hash.update(entry.content || '');
    hash.update('\u0001');
    hash.update(entry.toolCallId || '');
    hash.update('\u0001');
    hash.update(String(entry.toolError || false));
    if (entry.attachments?.length) {
      hash.update(JSON.stringify(entry.attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType,
        dataLength: attachment.data?.length || 0,
      }))));
    }
    if (entry.toolCalls?.length) {
      hash.update(JSON.stringify(entry.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments || {},
      }))));
    }
  }
  return hash.digest('hex');
}

export function cloneTranscriptEntries(entries: ContextTranscriptEntry[]): ContextTranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function cloneCompressionState(state: CompressionState): CompressionState {
  try {
    return CompressionState.deserialize(state.serialize());
  } catch {
    return new CompressionState();
  }
}
