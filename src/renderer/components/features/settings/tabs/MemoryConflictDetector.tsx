// ============================================================================
// MemoryConflictDetector - 记忆冲突检测与合并 (Phase 4)
// ============================================================================

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Merge, Trash2, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { MemoryItem, MemoryCategory } from '@shared/types';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('MemoryConflictDetector');

interface MemoryConflictDetectorProps {
  memories: MemoryItem[];
  onResolve?: () => void; // 冲突解决后的回调（刷新数据）
}

// 冲突类型
interface MemoryConflict {
  id: string;
  type: 'duplicate' | 'contradiction' | 'update';
  memories: MemoryItem[];
  description: string;
  severity: 'low' | 'medium' | 'high';
}

// 计算两个字符串的相似度 (简单 Jaccard 相似度)
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// 检测是否可能是矛盾的记忆
function detectContradiction(m1: MemoryItem, m2: MemoryItem): boolean {
  const content1 = m1.content.toLowerCase();
  const content2 = m2.content.toLowerCase();

  // 检测常见的矛盾模式
  const contradictionPatterns = [
    // "喜欢 X" vs "不喜欢 X"
    [/喜欢|prefer|like/, /不喜欢|不要|avoid|don't like/],
    // "使用 X" vs "不使用 X"
    [/使用|用|use/, /不使用|不用|don't use/],
    // "2 空格" vs "4 空格"
    [/2\s*空格|2\s*spaces/, /4\s*空格|4\s*spaces|tab/],
    // 数字变化
    [/\d+/, /\d+/],
  ];

  for (const [pattern1, pattern2] of contradictionPatterns) {
    if (
      (pattern1.test(content1) && pattern2.test(content2)) ||
      (pattern2.test(content1) && pattern1.test(content2))
    ) {
      // 同一主题但不同观点
      const similarity = calculateSimilarity(content1, content2);
      if (similarity > 0.3 && similarity < 0.9) {
        return true;
      }
    }
  }

  return false;
}

// 检测冲突
function detectConflicts(memories: MemoryItem[]): MemoryConflict[] {
  const conflicts: MemoryConflict[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const m1 = memories[i];
      const m2 = memories[j];

      // 跳过已处理的
      const pairKey = [m1.id, m2.id].sort().join('_');
      if (processed.has(pairKey)) continue;
      processed.add(pairKey);

      // 同一分类才检测
      if (m1.category !== m2.category) continue;

      const similarity = calculateSimilarity(m1.content, m2.content);

      // 高度相似 - 可能是重复
      if (similarity > 0.8) {
        conflicts.push({
          id: `dup_${m1.id}_${m2.id}`,
          type: 'duplicate',
          memories: [m1, m2],
          description: '这两条记忆内容高度相似，可能是重复的',
          severity: 'low',
        });
        continue;
      }

      // 检测矛盾
      if (detectContradiction(m1, m2)) {
        conflicts.push({
          id: `con_${m1.id}_${m2.id}`,
          type: 'contradiction',
          memories: [m1, m2],
          description: '这两条记忆可能存在矛盾，请确认哪个是最新的',
          severity: 'high',
        });
        continue;
      }

      // 检测可能需要更新的旧记忆
      if (
        similarity > 0.5 &&
        Math.abs(m1.createdAt - m2.createdAt) > 7 * 24 * 60 * 60 * 1000 // 超过 7 天
      ) {
        const older = m1.createdAt < m2.createdAt ? m1 : m2;
        const newer = m1.createdAt < m2.createdAt ? m2 : m1;
        conflicts.push({
          id: `upd_${m1.id}_${m2.id}`,
          type: 'update',
          memories: [older, newer],
          description: '较旧的记忆可能已过时，新记忆可能是更新版本',
          severity: 'medium',
        });
      }
    }
  }

  // 按严重程度排序
  const severityOrder = { high: 0, medium: 1, low: 2 };
  conflicts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return conflicts;
}

// 分类图标
const CATEGORY_ICONS: Record<MemoryCategory, string> = {
  about_me: '👤',
  preference: '⭐',
  frequent_info: '📋',
  learned: '💡',
};

// 严重程度配置
const SEVERITY_CONFIG = {
  high: { color: 'text-red-400', bgColor: 'bg-red-500/10', label: '需要处理' },
  medium: { color: 'text-amber-400', bgColor: 'bg-amber-500/10', label: '建议检查' },
  low: { color: 'text-blue-400', bgColor: 'bg-blue-500/10', label: '可能重复' },
};

export const MemoryConflictDetector: React.FC<MemoryConflictDetectorProps> = ({
  memories,
  onResolve,
}) => {
  const [expandedConflicts, setExpandedConflicts] = useState<Set<string>>(new Set());
  const [selectedMemory, setSelectedMemory] = useState<Record<string, string>>({});

  // 检测冲突
  const conflicts = useMemo(() => detectConflicts(memories), [memories]);

  // 展开/折叠冲突
  const toggleConflict = (id: string) => {
    setExpandedConflicts(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // 选择要保留的记忆
  const handleSelectMemory = (conflictId: string, memoryId: string) => {
    setSelectedMemory(prev => ({
      ...prev,
      [conflictId]: memoryId,
    }));
  };

  // 合并处理 - 保留选中的记忆，删除其他的
  const handleMerge = async (conflict: MemoryConflict) => {
    const keepId = selectedMemory[conflict.id];
    if (!keepId) return;

    const deleteIds = conflict.memories
      .filter(m => m.id !== keepId)
      .map(m => m.id);

    try {
      // 删除不保留的记忆
      for (const id of deleteIds) {
        await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
          action: 'delete',
          id,
        });
      }
      onResolve?.();
    } catch (error) {
      logger.error('Failed to merge memories', error);
    }
  };

  // 忽略冲突 - 只是折叠，不做任何操作
  const handleDismiss = (conflict: MemoryConflict) => {
    // 从展开列表中移除
    setExpandedConflicts(prev => {
      const next = new Set(prev);
      next.delete(conflict.id);
      return next;
    });
  };

  if (conflicts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
        <Check className="w-8 h-8 mb-2 text-green-500" />
        <p className="text-sm">没有检测到冲突</p>
        <p className="text-xs text-zinc-600 mt-1">所有记忆都是一致的</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 冲突统计 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/30 rounded-lg">
        <AlertTriangle className="w-4 h-4 text-amber-400" />
        <span className="text-sm text-zinc-300">
          检测到 {conflicts.length} 个潜在冲突
        </span>
        <div className="flex items-center gap-2 ml-auto text-xs">
          <span className="text-red-400">{conflicts.filter(c => c.severity === 'high').length} 高</span>
          <span className="text-amber-400">{conflicts.filter(c => c.severity === 'medium').length} 中</span>
          <span className="text-blue-400">{conflicts.filter(c => c.severity === 'low').length} 低</span>
        </div>
      </div>

      {/* 冲突列表 */}
      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        {conflicts.map(conflict => {
          const isExpanded = expandedConflicts.has(conflict.id);
          const selected = selectedMemory[conflict.id];
          const severityConfig = SEVERITY_CONFIG[conflict.severity];

          return (
            <div
              key={conflict.id}
              className="bg-zinc-800/30 rounded-lg overflow-hidden"
            >
              {/* 冲突标题 */}
              <button
                onClick={() => toggleConflict(conflict.id)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800/50 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-zinc-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-zinc-400" />
                )}

                <span className={`text-xs px-1.5 py-0.5 rounded ${severityConfig.bgColor} ${severityConfig.color}`}>
                  {severityConfig.label}
                </span>

                <span className="text-sm text-zinc-300 flex-1 text-left truncate">
                  {conflict.type === 'duplicate' && '重复记忆'}
                  {conflict.type === 'contradiction' && '矛盾记忆'}
                  {conflict.type === 'update' && '可能过时'}
                </span>

                <span className="text-xs text-zinc-500">
                  {CATEGORY_ICONS[conflict.memories[0].category]}
                </span>
              </button>

              {/* 冲突详情 */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-xs text-zinc-400">{conflict.description}</p>

                  {/* 冲突的记忆 */}
                  <div className="space-y-1.5">
                    {conflict.memories.map(memory => (
                      <label
                        key={memory.id}
                        className={`flex items-start gap-2 p-2 rounded cursor-pointer transition-colors ${
                          selected === memory.id
                            ? 'bg-indigo-500/20 border border-indigo-500/50'
                            : 'bg-zinc-900/50 hover:bg-zinc-900/80'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`conflict_${conflict.id}`}
                          checked={selected === memory.id}
                          onChange={() => handleSelectMemory(conflict.id, memory.id)}
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-200 line-clamp-2">
                            {memory.content}
                          </p>
                          <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                            <span>
                              {new Date(memory.createdAt).toLocaleDateString('zh-CN')}
                            </span>
                            {memory.source === 'learned' && (
                              <span className="text-purple-400">AI 学习</span>
                            )}
                            {memory.confidence < 1 && (
                              <span>{Math.round(memory.confidence * 100)}%</span>
                            )}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-2 pt-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleMerge(conflict)}
                      disabled={!selected}
                      className="flex items-center gap-1"
                    >
                      <Merge className="w-3.5 h-3.5" />
                      保留选中，删除其他
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleDismiss(conflict)}
                      className="flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" />
                      忽略
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
