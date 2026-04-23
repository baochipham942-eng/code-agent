// ============================================================================
// useStatusRailModel - 统一供给 InlineStrip 和 StatusRail 的数据 hook
// ============================================================================
// 聚合 appStore.contextHealth + sessionStore + statusStore + swarmStore
// 一份 model 被 InlineStrip / StatusRail / 概览页共同消费

import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSwarmStore } from '../stores/swarmStore';
import type { TodoItem } from '@shared/contract';
import type { ContextHealthWarningLevel, CompressionStats } from '@shared/contract/contextHealth';
import { getContextWindow } from '@shared/constants';
import { computeBucketSummary, extractContextItems, type BucketSummary, type ContextItem } from '../utils/contextBuckets';

// ── 产物提取（复用 TaskMonitor 的逻辑，提取为独立函数）──

const CORE_EXTENSIONS = new Set(['.pptx', '.pdf', '.xlsx', '.docx', '.mp4', '.html']);

export interface ArtifactItem {
  path: string;
  name: string;
  isCore: boolean;
}

function extractArtifacts(
  messages: Array<{ toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: { outputPath?: string; output?: string; metadata?: Record<string, unknown> } }> }>,
  workingDirectory: string | null,
  limit = 10,
): ArtifactItem[] {
  const files: ArtifactItem[] = [];
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();

  const addPath = (filePath: string) => {
    if (!filePath) return;
    let normalized = filePath.trim().replace(/\/+$/, '').replace(/\/\//g, '/');
    if (workingDirectory && !normalized.startsWith('/') && !normalized.startsWith('~')) {
      normalized = `${workingDirectory}/${normalized}`;
    }
    if (seenPaths.has(normalized)) return;
    const name = normalized.split('/').pop() || '';
    if (!name.includes('.')) return;
    if (seenNames.has(name)) return;
    seenPaths.add(normalized);
    seenNames.add(name);
    const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
    files.push({ path: normalized, name, isCore: CORE_EXTENSIONS.has(ext) });
  };

  for (const message of messages.slice(-30).reverse()) {
    if (!message.toolCalls) continue;
    for (const tc of message.toolCalls) {
      const args = tc.arguments as Record<string, unknown>;
      if (tc.result?.outputPath) addPath(tc.result.outputPath);
      if (['Write', 'Edit'].includes(tc.name)) {
        const fp = (args?.path || args?.file_path) as string | undefined;
        if (fp) addPath(fp);
      }
      if (['image_generate', 'video_generate'].includes(tc.name) && args?.output_path) {
        addPath(args.output_path as string);
      }
      const meta = tc.result?.metadata as Record<string, unknown> | undefined;
      if (meta) {
        for (const key of ['filePath', 'imagePath', 'videoPath', 'outputPath', 'pptxPath', 'pdfPath']) {
          if (meta[key] && typeof meta[key] === 'string') addPath(meta[key] as string);
        }
      }
      if (files.length >= limit) break;
    }
    if (files.length >= limit) break;
  }

  files.sort((a, b) => (a.isCore === b.isCore ? 0 : a.isCore ? -1 : 1));
  return files;
}

// ── Model 类型定义 ──

export interface StatusRailContextModel {
  currentTokens: number;
  maxTokens: number;
  usagePercent: number;
  warningLevel: ContextHealthWarningLevel;
  buckets: BucketSummary;
  items: ContextItem[];
}

export interface StatusRailCompactModel {
  canCompact: boolean;
  compressionCount: number;
  totalSavedTokens: number;
}

export interface StatusRailTodoModel {
  items: TodoItem[];
  completed: number;
  total: number;
}

export interface StatusRailOutputModel {
  files: ArtifactItem[];
  count: number;
}

export interface StatusRailSwarmModel {
  isRunning: boolean;
  agentCount: number;
  selectedAgentId: string | null;
}

export interface StatusRailCacheModel {
  promptCacheHits: number;
  promptCacheMisses: number;
  totalCachedTokens: number;
  hitRate: number; // 0-1
}

export interface StatusRailModel {
  context: StatusRailContextModel;
  compact: StatusRailCompactModel;
  todos: StatusRailTodoModel;
  outputs: StatusRailOutputModel;
  swarm: StatusRailSwarmModel;
  cache: StatusRailCacheModel;
}

// ── Hook ──

export function useStatusRailModel(): StatusRailModel {
  const contextHealth = useAppStore((s) => s.contextHealth);
  const selectedSwarmAgentId = useAppStore((s) => s.selectedSwarmAgentId);
  const workingDirectory = useAppStore((s) => s.workingDirectory);
  const cacheStats = useAppStore((s) => s.cacheStats);
  const currentModel = useAppStore((s) => s.modelConfig?.model);

  const todos = useSessionStore((s) => s.todos);
  const messages = useSessionStore((s) => s.messages);

  const swarmIsRunning = useSwarmStore((s) => s.isRunning);
  const swarmAgents = useSwarmStore((s) => s.agents);

  // Context
  const context = useMemo<StatusRailContextModel>(() => {
    const buckets = computeBucketSummary(messages);
    const items = extractContextItems(messages);
    if (!contextHealth) {
      return {
        currentTokens: 0,
        maxTokens: getContextWindow(currentModel ?? ''),
        usagePercent: 0,
        warningLevel: 'normal' as const,
        buckets,
        items,
      };
    }
    return {
      currentTokens: contextHealth.currentTokens,
      maxTokens: contextHealth.maxTokens,
      usagePercent: contextHealth.usagePercent,
      warningLevel: contextHealth.warningLevel,
      buckets,
      items,
    };
  }, [contextHealth, messages, currentModel]);

  // Compact
  const compact = useMemo<StatusRailCompactModel>(() => {
    const compression: CompressionStats | undefined = contextHealth?.compression;
    return {
      canCompact: (contextHealth?.usagePercent ?? 0) >= 70,
      compressionCount: compression?.compressionCount ?? 0,
      totalSavedTokens: compression?.totalSavedTokens ?? 0,
    };
  }, [contextHealth]);

  // Todos
  const todoModel = useMemo<StatusRailTodoModel>(() => {
    const completed = todos.filter((t) => t.status === 'completed').length;
    return { items: todos, completed, total: todos.length };
  }, [todos]);

  // Outputs
  const outputs = useMemo<StatusRailOutputModel>(() => {
    const files = extractArtifacts(messages, workingDirectory);
    return { files, count: files.length };
  }, [messages, workingDirectory]);

  // Swarm
  const swarm = useMemo<StatusRailSwarmModel>(() => ({
    isRunning: swarmIsRunning,
    agentCount: swarmAgents.length,
    selectedAgentId: selectedSwarmAgentId,
  }), [swarmIsRunning, swarmAgents.length, selectedSwarmAgentId]);

  // Cache
  const cache = useMemo<StatusRailCacheModel>(() => {
    if (!cacheStats) {
      return { promptCacheHits: 0, promptCacheMisses: 0, totalCachedTokens: 0, hitRate: 0 };
    }
    const total = cacheStats.promptCacheHits + cacheStats.promptCacheMisses;
    return {
      promptCacheHits: cacheStats.promptCacheHits,
      promptCacheMisses: cacheStats.promptCacheMisses,
      totalCachedTokens: cacheStats.totalCachedTokens,
      hitRate: total > 0 ? cacheStats.promptCacheHits / total : 0,
    };
  }, [cacheStats]);

  return { context, compact, todos: todoModel, outputs, swarm, cache };
}
