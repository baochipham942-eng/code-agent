// ============================================================================
// Order-preserving tool segments. A call joins the current segment only when
// it conflicts with none of the calls already there. A barrier closes the
// segment, runs alone, and defers every later call.
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import type { MCPToolAnnotations } from '../../mcp/types';
import type { ToolClassification } from '../loopTypes';
import {
  toolResourceAccessesConflict,
  type ResolvedToolAccess,
} from '../../security/resourceScope';
import {
  isBarrierToolCall,
  resolveToolCallAccesses,
} from '../../tools/dispatch/resolveToolCallAccess';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ParallelStrategy');

const UNKNOWN_READWRITE: ResolvedToolAccess = { kind: 'readwrite', domain: { type: 'unknown' } };

export interface OrderedToolCall {
  readonly index: number;
  readonly toolCall: ToolCall;
}

export interface ExecuteOrderedSegmentsOptions<R> {
  readonly resultCount: number;
  readonly maxParallel: number;
  shouldHalt(): boolean;
  prepare(entry: OrderedToolCall, batchSize: number): void;
  run(entry: OrderedToolCall, parallel: boolean): Promise<R>;
  deferredResult(entry: OrderedToolCall): R;
}

function accessesConflict(
  left: readonly ResolvedToolAccess[],
  right: readonly ResolvedToolAccess[],
): boolean {
  const leftAccesses = left.length > 0 ? left : [UNKNOWN_READWRITE];
  const rightAccesses = right.length > 0 ? right : [UNKNOWN_READWRITE];
  return leftAccesses.some((access) => rightAccesses.some((other) => toolResourceAccessesConflict(access, other)));
}

export function classifyToolCalls(
  toolCalls: readonly ToolCall[],
  toolAnnotations?: Map<string, MCPToolAnnotations>,
  options?: { readonly workspace?: string; readonly cwd?: string },
): ToolClassification {
  const workspace = options?.workspace ?? '.';
  const cwd = options?.cwd ?? '.';
  const resolveOptions = { workspace, cwd, mcpAnnotations: toolAnnotations };
  const segments: ToolClassification['segments'] = [];
  const deferred: ToolClassification['deferred'] = [];
  const resolvedByIndex: ResolvedToolAccess[][] = [];
  let current: Array<{ index: number; toolCall: ToolCall }> = [];
  let closed = false;

  const accessesAt = (index: number, toolCall: ToolCall): readonly ResolvedToolAccess[] => {
    const cached = resolvedByIndex[index];
    if (cached) return cached;
    const resolved = resolveToolCallAccesses(toolCall, resolveOptions);
    const accesses = resolved.length > 0 ? resolved : [UNKNOWN_READWRITE];
    resolvedByIndex[index] = accesses;
    return accesses;
  };

  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    const entry = { index, toolCall };
    if (closed) {
      deferred.push(entry);
      continue;
    }
    if (isBarrierToolCall(toolCall)) {
      if (current.length > 0) segments.push(current);
      segments.push([entry]);
      current = [];
      closed = true;
      continue;
    }
    const accesses = accessesAt(index, toolCall);
    const conflicts = current.some((member) => accessesConflict(
      accesses,
      accessesAt(member.index, member.toolCall),
    ));
    if (!conflicts) {
      current.push(entry);
      continue;
    }
    segments.push(current);
    current = [entry];
  }
  if (current.length > 0) segments.push(current);

  logger.debug(`Tool classification: ${segments.length} segments, ${deferred.length} deferred`);
  return { segments, deferred };
}

export function toolBatchLabel(toolName: string, batchSize: number, researchMode: boolean): string {
  if (batchSize > 1) return `并行执行 ${batchSize} 个工具`;
  if (researchMode && toolName === 'web_fetch') return '正在抓取详情...';
  return `执行 ${toolName}`;
}

/** 段内按上限切片。取消或需要重推理时停在下一片之前；屏障后的调用始终补结果。 */
export async function executeOrderedSegments<R>(
  segments: ReadonlyArray<ReadonlyArray<OrderedToolCall>>,
  deferred: ReadonlyArray<OrderedToolCall>,
  options: ExecuteOrderedSegmentsOptions<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = Array.from({ length: options.resultCount });
  let halted = false;
  for (const segment of segments) {
    if (halted) break;
    for (let start = 0; start < segment.length; start += options.maxParallel) {
      if (options.shouldHalt()) {
        halted = true;
        break;
      }
      const batch = segment.slice(start, start + options.maxParallel);
      const parallel = batch.length > 1;
      for (const entry of batch) options.prepare(entry, batch.length);
      const batchResults = await Promise.all(batch.map(async (entry) => ({
        index: entry.index,
        result: await options.run(entry, parallel),
      })));
      for (const item of batchResults) results[item.index] = item.result;
    }
  }
  for (const entry of deferred) results[entry.index] = options.deferredResult(entry);
  return results;
}
