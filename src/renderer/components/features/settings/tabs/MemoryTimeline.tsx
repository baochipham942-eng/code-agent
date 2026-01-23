// ============================================================================
// MemoryTimeline - 记忆时间线视图 (Phase 4)
// ============================================================================

import React, { useMemo } from 'react';
import { Calendar, Brain, Sparkles, Clock, ArrowRight } from 'lucide-react';
import type { MemoryItem, MemoryCategory } from '@shared/types';

interface MemoryTimelineProps {
  memories: MemoryItem[];
  onSelectMemory?: (memory: MemoryItem) => void;
}

// 时间分组类型
type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'older';

// 分组标签
const TIME_GROUP_LABELS: Record<TimeGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  thisMonth: '本月',
  older: '更早',
};

// 分类图标和颜色
const CATEGORY_CONFIG: Record<MemoryCategory, { icon: string; color: string; bgColor: string }> = {
  about_me: { icon: '👤', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  preference: { icon: '⭐', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  frequent_info: { icon: '📋', color: 'text-green-400', bgColor: 'bg-green-500/10' },
  learned: { icon: '💡', color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
};

// 获取时间分组
function getTimeGroup(timestamp: number): TimeGroup {
  const now = new Date();
  const date = new Date(timestamp);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(today.getTime() - today.getDay() * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (date >= today) return 'today';
  if (date >= yesterday) return 'yesterday';
  if (date >= weekStart) return 'thisWeek';
  if (date >= monthStart) return 'thisMonth';
  return 'older';
}

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export const MemoryTimeline: React.FC<MemoryTimelineProps> = ({
  memories,
  onSelectMemory,
}) => {
  // 按时间分组
  const groupedMemories = useMemo(() => {
    const groups: Record<TimeGroup, MemoryItem[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      thisMonth: [],
      older: [],
    };

    // 按创建时间排序
    const sorted = [...memories].sort((a, b) => b.createdAt - a.createdAt);

    for (const memory of sorted) {
      const group = getTimeGroup(memory.createdAt);
      groups[group].push(memory);
    }

    return groups;
  }, [memories]);

  // 非空分组
  const nonEmptyGroups = useMemo(() => {
    return (Object.keys(groupedMemories) as TimeGroup[]).filter(
      (group) => groupedMemories[group].length > 0
    );
  }, [groupedMemories]);

  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
        <Calendar className="w-8 h-8 mb-2" />
        <p className="text-sm">暂无记忆</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 统计概览 */}
      <div className="flex items-center gap-4 px-3 py-2 bg-zinc-800/30 rounded-lg">
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Brain className="w-3.5 h-3.5" />
          <span>共 {memories.length} 条记忆</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Sparkles className="w-3.5 h-3.5" />
          <span>{memories.filter(m => m.source === 'learned').length} 条自动学习</span>
        </div>
      </div>

      {/* 时间线 */}
      <div className="relative">
        {/* 时间线轴 */}
        <div className="absolute left-4 top-0 bottom-0 w-px bg-gradient-to-b from-zinc-600 via-zinc-700 to-transparent" />

        {/* 时间分组 */}
        {nonEmptyGroups.map((group) => (
          <div key={group} className="relative mb-4 last:mb-0">
            {/* 分组标题 */}
            <div className="flex items-center gap-2 mb-2 ml-8">
              <div className="absolute left-[13px] w-2.5 h-2.5 rounded-full bg-zinc-600 border-2 border-zinc-900" />
              <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                {TIME_GROUP_LABELS[group]}
              </span>
              <span className="text-xs text-zinc-600">
                ({groupedMemories[group].length})
              </span>
            </div>

            {/* 该分组的记忆条目 */}
            <div className="space-y-1.5 ml-8">
              {groupedMemories[group].map((memory) => {
                const config = CATEGORY_CONFIG[memory.category];
                const isLearned = memory.source === 'learned';

                return (
                  <button
                    key={memory.id}
                    onClick={() => onSelectMemory?.(memory)}
                    className="w-full flex items-start gap-2 p-2 rounded-lg bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors text-left group"
                  >
                    {/* 分类图标 */}
                    <span className={`text-sm ${config.bgColor} rounded p-1`}>
                      {config.icon}
                    </span>

                    {/* 内容 */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200 line-clamp-2">
                        {memory.content}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-zinc-500 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(memory.createdAt)}
                        </span>
                        {isLearned && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                            AI 学习
                          </span>
                        )}
                        {memory.confidence < 1 && (
                          <span className="text-xs text-zinc-500">
                            {Math.round(memory.confidence * 100)}%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 箭头 */}
                    <ArrowRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors opacity-0 group-hover:opacity-100" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
