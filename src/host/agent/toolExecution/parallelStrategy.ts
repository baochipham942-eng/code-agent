// ============================================================================
// Parallel Execution Strategy - Tool execution parallelization logic
// ============================================================================

import type { ToolCall } from '../../../shared/contract';
import type { MCPToolAnnotations } from '../../mcp/types';
import { isMcpToolReadOnly } from '../../mcp/mcpToolSafety';
import type { ToolClassification } from '../loopTypes';
import { PARALLEL_SAFE_TOOLS, MAX_PARALLEL_TOOLS } from '../loopTypes';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ParallelStrategy');

/**
 * Check if a tool is safe for parallel execution
 *
 * A tool is parallel-safe if:
 * 1. It's in the PARALLEL_SAFE_TOOLS set (built-in tools)
 * 2. It's an MCP tool classified via annotations (readOnlyHint=true, destructiveHint!=true)
 * Missing MCP annotations are sequential (fail closed).
 */
export function isParallelSafeTool(toolName: string, toolAnnotations?: MCPToolAnnotations): boolean {
  if (toolName.startsWith('mcp_')) {
    return isMcpToolReadOnly(toolAnnotations);
  }
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

/**
 * Classify tool calls into parallel-safe and sequential groups
 *
 * @param toolCalls - Array of tool calls to classify
 * @param toolAnnotations - Optional MCP tool annotations map (key: full tool name)
 * @returns Classification result with parallel and sequential groups
 */
/** Parallel-safe tools that may still write through a subagent; they end the read-hoisting prefix. */
const WRITE_CAPABLE_PARALLEL_TOOLS = new Set(['Task']);

export function classifyToolCalls(
  toolCalls: ToolCall[],
  toolAnnotations?: Map<string, MCPToolAnnotations>,
): ToolClassification {
  const parallelGroup: Array<{ index: number; toolCall: ToolCall }> = [];
  const sequentialGroup: Array<{ index: number; toolCall: ToolCall }> = [];

  // 引擎先跑整个并行组、再按序跑串行组。只有「第一个非并行安全调用之前」的读才能安全提前：
  // 一旦越过一次写（Write/Edit/Bash…），后面的 Read/Grep/Glob 必须留在原位，否则同批
  // [Write(a.txt), Read(a.txt)] 会先读后写（ai-review 09-06）。保序分段的完整方案归 N-TOOL-RESOURCE-ADR。
  // Task 在白名单里是为了子代理能扇出，但 coder 这类子代理会写文件：它本身可以并行，
  // 却是后续读的写边界（二裁 09-06：[Task(coder 改 a.txt), Read(a.txt)] 不能同批并发）。
  let crossedWriteBoundary = false;
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const annotations = toolAnnotations?.get(toolCall.name);
    const writeCapable = WRITE_CAPABLE_PARALLEL_TOOLS.has(toolCall.name);
    if (isParallelSafeTool(toolCall.name, annotations) && (writeCapable || !crossedWriteBoundary)) {
      parallelGroup.push({ index: i, toolCall });
    } else {
      sequentialGroup.push({ index: i, toolCall });
    }
    if (writeCapable || !isParallelSafeTool(toolCall.name, annotations)) crossedWriteBoundary = true;
  }

  logger.debug(
    `Tool classification: ${parallelGroup.length} parallel-safe, ${sequentialGroup.length} sequential`
  );

  return { parallelGroup, sequentialGroup };
}

/**
 * Get batch slices for parallel execution
 *
 * Splits the parallel group into batches of MAX_PARALLEL_TOOLS size
 *
 * @param parallelGroup - Array of parallel-safe tool calls
 * @returns Array of batches
 */
export function getBatchSlices<T>(
  items: T[]
): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PARALLEL_TOOLS) {
    batches.push(items.slice(i, i + MAX_PARALLEL_TOOLS));
  }
  return batches;
}

/**
 * Execute items in parallel batches
 *
 * @param items - Items to process
 * @param executor - Async function to execute each item
 * @param maxParallel - Maximum parallel executions (defaults to MAX_PARALLEL_TOOLS)
 * @returns Results in the same order as input
 */
export async function executeInBatches<T, R>(
  items: Array<{ index: number; item: T }>,
  executor: (item: T, index: number) => Promise<R>,
  maxParallel: number = MAX_PARALLEL_TOOLS
): Promise<Array<{ index: number; result: R }>> {
  const results: Array<{ index: number; result: R }> = [];

  for (let batchStart = 0; batchStart < items.length; batchStart += maxParallel) {
    const batch = items.slice(batchStart, batchStart + maxParallel);

    const batchPromises = batch.map(async ({ index, item }) => {
      const result = await executor(item, index);
      return { index, result };
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Parallel execution configuration
 */
export interface ParallelExecutionConfig {
  maxParallelTools: number;
  enabled: boolean;
}

/**
 * Default parallel execution configuration
 */
export const DEFAULT_PARALLEL_CONFIG: ParallelExecutionConfig = {
  maxParallelTools: MAX_PARALLEL_TOOLS,
  enabled: true,
};

/**
 * Create a parallel execution strategy with custom configuration
 */
export function createParallelStrategy(config: Partial<ParallelExecutionConfig> = {}) {
  const finalConfig = { ...DEFAULT_PARALLEL_CONFIG, ...config };

  return {
    isParallelSafe: (name: string, annotations?: MCPToolAnnotations) => isParallelSafeTool(name, annotations),
    classify: (calls: ToolCall[], annotations?: Map<string, MCPToolAnnotations>) => classifyToolCalls(calls, annotations),
    getBatches: <T>(items: T[]) => {
      const batches: T[][] = [];
      const batchSize = finalConfig.maxParallelTools;
      for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
      }
      return batches;
    },
    execute: async <T, R>(
      items: Array<{ index: number; item: T }>,
      executor: (item: T, index: number) => Promise<R>
    ) => executeInBatches(items, executor, finalConfig.maxParallelTools),
    config: finalConfig,
  };
}
