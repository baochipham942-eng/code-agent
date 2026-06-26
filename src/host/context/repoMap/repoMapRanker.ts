// ============================================================================
// Repo Map Ranker — 依赖图构建 + PageRank 排序 + Token 预算裁剪
// ============================================================================

import type { RepoMapEntry, DependencyNode, RepoMapResult, SymbolEntry } from './types';
import { estimateTokens } from '../tokenEstimator';

const DEFAULT_TOKEN_BUDGET = 1500;
const PAGERANK_ITERATIONS = 20;
const PAGERANK_DAMPING = 0.85;

/** 从 entries 构建依赖图并执行 PageRank */
function buildDependencyGraph(entries: Map<string, RepoMapEntry>): Map<string, DependencyNode> {
  const graph = new Map<string, DependencyNode>();

  // 初始化节点
  for (const [filePath] of entries) {
    graph.set(filePath, { path: filePath, inDegree: 0, outDegree: 0, rank: 1.0 });
  }

  // 构建边：file A imports file B → A→B 有向边
  const adjacency = new Map<string, Set<string>>();

  for (const [filePath, entry] of entries) {
    const targets = new Set<string>();
    for (const imp of entry.imports) {
      if (entries.has(imp)) {
        targets.add(imp);
        const target = graph.get(imp)!;
        target.inDegree++;
      }
    }
    adjacency.set(filePath, targets);
    const node = graph.get(filePath)!;
    node.outDegree = targets.size;
  }

  // PageRank 迭代
  const n = graph.size;
  if (n === 0) return graph;

  for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
    const newRanks = new Map<string, number>();

    for (const [filePath] of graph) {
      let incoming = 0;
      // 找所有指向 filePath 的节点
      for (const [source, targets] of adjacency) {
        if (targets.has(filePath)) {
          const sourceNode = graph.get(source)!;
          incoming += sourceNode.rank / (sourceNode.outDegree || 1);
        }
      }
      newRanks.set(filePath, (1 - PAGERANK_DAMPING) / n + PAGERANK_DAMPING * incoming);
    }

    for (const [filePath, rank] of newRanks) {
      graph.get(filePath)!.rank = rank;
    }
  }

  return graph;
}

/** 格式化单个文件的符号列表（Aider 风格） */
function formatFileEntry(relativePath: string, symbols: SymbolEntry[]): string {
  const lines: string[] = [relativePath];

  for (const sym of symbols) {
    // 只显示 exported 符号（减少噪音）
    if (!sym.exported) continue;

    const kindPrefix = sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'enum'
      ? `${sym.kind} ` : '';
    const sig = sym.signature ? `(${sym.signature})` : '';
    lines.push(`│ ${kindPrefix}${sym.name}${sig}`);
  }

  // 如果没有 exported 符号，显示所有符号
  if (lines.length === 1) {
    for (const sym of symbols.slice(0, 5)) {
      const kindPrefix = sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'enum'
        ? `${sym.kind} ` : '';
      const sig = sym.signature ? `(${sym.signature})` : '';
      lines.push(`│ ${kindPrefix}${sym.name}${sig}`);
    }
    if (symbols.length > 5) {
      lines.push(`│ ... +${symbols.length - 5} more`);
    }
  }

  return lines.join('\n');
}

/** 根据 PageRank 排序并在 token 预算内生成 Repo Map 文本 */
export function rankAndFormat(
  entries: Map<string, RepoMapEntry>,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): RepoMapResult {
  if (entries.size === 0) {
    return { text: '', fileCount: 0, symbolCount: 0, estimatedTokens: 0 };
  }

  // 构建依赖图并排序
  const graph = buildDependencyGraph(entries);
  const ranked = [...graph.values()].sort((a, b) => b.rank - a.rank);

  // 按 token 预算裁剪
  const outputParts: string[] = [];
  let totalTokens = 0;
  let fileCount = 0;
  let symbolCount = 0;

  for (const node of ranked) {
    const entry = entries.get(node.path);
    if (!entry) continue;

    const formatted = formatFileEntry(entry.relativePath, entry.symbols);
    const entryTokens = estimateTokens(formatted);

    if (totalTokens + entryTokens > tokenBudget && fileCount > 0) {
      break;
    }

    outputParts.push(formatted);
    totalTokens += entryTokens;
    fileCount++;
    symbolCount += entry.symbols.length;
  }

  const text = outputParts.join('\n');

  return { text, fileCount, symbolCount, estimatedTokens: totalTokens };
}

export { buildDependencyGraph };
