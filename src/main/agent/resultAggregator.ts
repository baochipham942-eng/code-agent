// ============================================================================
// Result Aggregator - 并行 Agent Team 结果聚合
// ============================================================================
//
// 从各 agent 的原始结果中提取结构化信息：
// - 变更文件列表（去重合并）
// - 费用/token/迭代汇总
// - 成功率
// - 并行加速比
// ============================================================================

import type { AgentTaskResult } from './parallelAgentCoordinator';

// ============================================================================
// Types
// ============================================================================

export interface AgentResultEntry {
  agentId: string;
  role: string;
  status: 'completed' | 'failed';
  resultPreview: string;
  filesChanged: string[];
  stats: {
    toolCalls: number;
    iterations: number;
    cost?: number;
    durationMs: number;
  };
}

export interface AggregatedTeamResult {
  /** One-line summary */
  summary: string;
  /** Per-agent results */
  agentResults: AgentResultEntry[];
  /** Deduplicated file paths changed across all agents */
  filesChanged: string[];
  /** Total cost in USD */
  totalCost: number;
  /** Wall-clock duration (ms) */
  totalDuration: number;
  /** Sum of all agent durations (ms) — used to compute speedup */
  serialDuration: number;
  /** Parallel speedup ratio */
  speedup: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Total iterations across all agents */
  totalIterations: number;
  /** Total tool calls across all agents */
  totalToolCalls: number;
}

// ============================================================================
// File path extraction
// ============================================================================

/**
 * Extract file paths from agent output text.
 * Matches common patterns: explicit file lists, diff headers, edit mentions.
 */
function extractFilePaths(output: string): string[] {
  if (!output) return [];

  const paths = new Set<string>();

  // Pattern 1: "src/foo/bar.ts" — path-like tokens with extension
  const pathRegex = /(?:^|\s)((?:src|lib|test|tests|app|packages|components|pages|api|utils|config|scripts|docs)\/[\w./-]+\.\w{1,8})/gm;
  for (const match of output.matchAll(pathRegex)) {
    paths.add(match[1]);
  }

  // Pattern 2: "Modified: path" or "Created: path" or "Changed: path"
  const modifiedRegex = /(?:Modified|Created|Changed|Updated|Edited|Wrote|Added|Deleted):\s*(.+\.\w{1,8})/gi;
  for (const match of output.matchAll(modifiedRegex)) {
    const p = match[1].trim();
    if (p.includes('/')) paths.add(p);
  }

  // Pattern 3: Lines that are just file paths (from "files changed" sections)
  const linePathRegex = /^[\s-]*([a-zA-Z][\w./-]+\.\w{1,8})\s*$/gm;
  for (const match of output.matchAll(linePathRegex)) {
    if (match[1].includes('/')) paths.add(match[1]);
  }

  return Array.from(paths).sort();
}

// ============================================================================
// Aggregation
// ============================================================================

/**
 * Aggregate parallel agent results into a structured summary.
 */
export function aggregateTeamResults(
  results: AgentTaskResult[],
  totalDuration: number
): AggregatedTeamResult {
  const agentResults: AgentResultEntry[] = [];
  const allFiles = new Set<string>();
  let totalCost = 0;
  let totalIterations = 0;
  let totalToolCalls = 0;
  let serialDuration = 0;
  let succeeded = 0;

  for (const r of results) {
    const files = extractFilePaths(r.output);
    files.forEach(f => allFiles.add(f));

    const entry: AgentResultEntry = {
      agentId: r.taskId,
      role: r.role,
      status: r.success ? 'completed' : 'failed',
      resultPreview: r.output?.slice(0, 200) || '',
      filesChanged: files,
      stats: {
        toolCalls: r.toolsUsed.length,
        iterations: r.iterations,
        cost: r.cost,
        durationMs: r.duration,
      },
    };

    agentResults.push(entry);
    totalCost += r.cost || 0;
    totalIterations += r.iterations;
    totalToolCalls += r.toolsUsed.length;
    serialDuration += r.duration;
    if (r.success) succeeded++;
  }

  const successRate = results.length > 0 ? succeeded / results.length : 0;
  const speedup = totalDuration > 0 ? serialDuration / totalDuration : 1;

  // Generate summary
  const summary = `${succeeded}/${results.length} agents succeeded in ${(totalDuration / 1000).toFixed(1)}s (${speedup.toFixed(1)}x speedup), ${allFiles.size} files changed, $${totalCost.toFixed(4)} cost`;

  return {
    summary,
    agentResults,
    filesChanged: Array.from(allFiles).sort(),
    totalCost,
    totalDuration,
    serialDuration,
    speedup,
    successRate,
    totalIterations,
    totalToolCalls,
  };
}
