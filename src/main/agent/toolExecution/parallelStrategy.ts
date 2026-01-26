// ============================================================================
// Parallel Execution Strategy - Tool execution parallelization logic
// ============================================================================

import type { ToolCall } from '../../../shared/types';
import type { ToolClassification } from '../loopTypes';
import { PARALLEL_SAFE_TOOLS, MAX_PARALLEL_TOOLS } from '../loopTypes';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ParallelStrategy');

/**
 * Check if a tool is safe for parallel execution
 *
 * A tool is parallel-safe if:
 * 1. It's in the PARALLEL_SAFE_TOOLS set
 * 2. It's an MCP tool that doesn't write/create (read-only MCP operations)
 */
export function isParallelSafeTool(toolName: string): boolean {
  // MCP tools that are read-only
  if (toolName.startsWith('mcp_') && !toolName.includes('write') && !toolName.includes('create')) {
    return true;
  }
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

/**
 * Classify tool calls into parallel-safe and sequential groups
 *
 * @param toolCalls - Array of tool calls to classify
 * @returns Classification result with parallel and sequential groups
 */
export function classifyToolCalls(toolCalls: ToolCall[]): ToolClassification {
  const parallelGroup: Array<{ index: number; toolCall: ToolCall }> = [];
  const sequentialGroup: Array<{ index: number; toolCall: ToolCall }> = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    if (isParallelSafeTool(toolCall.name)) {
      parallelGroup.push({ index: i, toolCall });
    } else {
      sequentialGroup.push({ index: i, toolCall });
    }
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
    isParallelSafe: isParallelSafeTool,
    classify: classifyToolCalls,
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
