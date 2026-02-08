// ============================================================================
// DAG Scheduler - Dependency-aware tool execution scheduling
// ============================================================================

import type { ToolCall } from '../../../shared/types';
import { createLogger } from '../../services/infra/logger';
import { MAX_PARALLEL_TOOLS } from '../loopTypes';

const logger = createLogger('DAGScheduler');

export interface ToolNode {
  index: number;
  toolCall: ToolCall;
  dependencies: number[];
  dependants: number[];
}

export interface ToolExecutionDAG {
  nodes: ToolNode[];
  executionOrder: number[][];
  maxParallelism: number;
  hasDependencies: boolean;
}

/**
 * Extract file path from tool call arguments
 */
function extractFilePath(toolCall: ToolCall): string | null {
  const args = toolCall.arguments;
  if (!args || typeof args !== 'object') return null;
  return (args as any).file_path || (args as any).path || null;
}

/**
 * Extract write paths from bash command (> and >> redirection)
 */
function extractBashWritePaths(toolCall: ToolCall): string[] {
  if (toolCall.name !== 'bash') return [];
  const command = (toolCall.arguments as any)?.command;
  if (!command || typeof command !== 'string') return [];

  const paths: string[] = [];
  // Match >> or > followed by a path
  const redirectRegex = />>?\s*([^\s;|&]+)/g;
  let match;
  while ((match = redirectRegex.exec(command)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Check if a tool writes to a file
 */
function isWriteTool(name: string): boolean {
  return ['edit_file', 'write_file'].includes(name);
}

/**
 * Check if a tool reads a file
 */
function isReadTool(name: string): boolean {
  return ['read_file'].includes(name);
}

/**
 * Build a DAG from tool calls based on file dependencies
 */
export function buildToolExecutionDAG(toolCalls: ToolCall[]): ToolExecutionDAG {
  const nodes: ToolNode[] = toolCalls.map((tc, i) => ({
    index: i,
    toolCall: tc,
    dependencies: [],
    dependants: [],
  }));

  // Build file -> tool index maps
  const fileReaders = new Map<string, number[]>(); // file -> [reader indices]
  const fileWriters = new Map<string, number[]>(); // file -> [writer indices]

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const path = extractFilePath(tc);

    if (path) {
      if (isReadTool(tc.name)) {
        if (!fileReaders.has(path)) fileReaders.set(path, []);
        fileReaders.get(path)!.push(i);
      }
      if (isWriteTool(tc.name)) {
        if (!fileWriters.has(path)) fileWriters.set(path, []);
        fileWriters.get(path)!.push(i);
      }
    }

    // Bash write paths
    const bashPaths = extractBashWritePaths(tc);
    for (const bp of bashPaths) {
      if (!fileWriters.has(bp)) fileWriters.set(bp, []);
      fileWriters.get(bp)!.push(i);
    }
  }

  let hasDependencies = false;

  // WAR: edit_file(X) depends on read_file(X) that comes before it
  for (const [path, writerIndices] of fileWriters) {
    const readerIndices = fileReaders.get(path) || [];
    for (const wi of writerIndices) {
      for (const ri of readerIndices) {
        if (ri < wi && !nodes[wi].dependencies.includes(ri)) {
          nodes[wi].dependencies.push(ri);
          nodes[ri].dependants.push(wi);
          hasDependencies = true;
        }
      }
    }
  }

  // WAW: concurrent writes to same file must be serialized
  for (const [, writerIndices] of fileWriters) {
    for (let i = 1; i < writerIndices.length; i++) {
      const prev = writerIndices[i - 1];
      const curr = writerIndices[i];
      if (!nodes[curr].dependencies.includes(prev)) {
        nodes[curr].dependencies.push(prev);
        nodes[prev].dependants.push(curr);
        hasDependencies = true;
      }
    }
  }

  // Topological sort using Kahn's algorithm
  const executionOrder = kahnSort(nodes);
  const maxParallelism = Math.max(...executionOrder.map(layer => layer.length), 0);

  logger.debug(`DAG built: ${nodes.length} nodes, ${executionOrder.length} layers, deps=${hasDependencies}`);

  return { nodes, executionOrder, maxParallelism, hasDependencies };
}

/**
 * Kahn's algorithm for topological sort, producing layered batches
 */
function kahnSort(nodes: ToolNode[]): number[][] {
  const inDegree = new Map<number, number>();
  for (const node of nodes) {
    inDegree.set(node.index, node.dependencies.length);
  }

  const layers: number[][] = [];
  const remaining = new Set(nodes.map(n => n.index));

  while (remaining.size > 0) {
    const layer: number[] = [];
    for (const idx of remaining) {
      if ((inDegree.get(idx) || 0) === 0) {
        layer.push(idx);
      }
    }

    if (layer.length === 0) {
      // Cycle detected - break by adding remaining as a single layer
      logger.warn('DAG cycle detected, executing remaining sequentially');
      layers.push([...remaining]);
      break;
    }

    layers.push(layer);

    for (const idx of layer) {
      remaining.delete(idx);
      const node = nodes[idx];
      for (const dep of node.dependants) {
        inDegree.set(dep, (inDegree.get(dep) || 1) - 1);
      }
    }
  }

  return layers;
}

/**
 * Execute tool calls according to DAG dependencies
 */
export async function executeWithDAG<T>(
  toolCalls: ToolCall[],
  executor: (tc: ToolCall, idx: number) => Promise<T>,
  maxParallel: number = MAX_PARALLEL_TOOLS
): Promise<{ results: Map<number, T>; dag: ToolExecutionDAG }> {
  const dag = buildToolExecutionDAG(toolCalls);

  // Fast path: no dependencies, return null to signal caller to use existing strategy
  if (!dag.hasDependencies) {
    return { results: new Map(), dag };
  }

  const results = new Map<number, T>();

  for (const layer of dag.executionOrder) {
    // Execute layer in parallel batches
    const batches: number[][] = [];
    for (let i = 0; i < layer.length; i += maxParallel) {
      batches.push(layer.slice(i, i + maxParallel));
    }

    for (const batch of batches) {
      const promises = batch.map(async (idx) => {
        const result = await executor(toolCalls[idx], idx);
        results.set(idx, result);
      });
      await Promise.all(promises);
    }
  }

  return { results, dag };
}
