// ============================================================================
// MemoryStatsPanel - 记忆统计面板 (Phase 4)
// ============================================================================

import React, { useMemo } from 'react';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Brain,
  Sparkles,
  Calendar,
  PieChart,
  Activity,
} from 'lucide-react';
import type { MemoryItem, MemoryCategory, MemoryStats } from '@shared/types';

interface MemoryStatsPanelProps {
  memories: MemoryItem[];
  stats: MemoryStats | null;
}

// 分类配置
const CATEGORY_CONFIG: Record<MemoryCategory, { label: string; icon: string; color: string }> = {
  about_me: { label: '关于我', icon: '👤', color: '#3b82f6' },
  preference: { label: '偏好', icon: '⭐', color: '#f59e0b' },
  frequent_info: { label: '常用信息', icon: '📋', color: '#10b981' },
  learned: { label: '学习', icon: '💡', color: '#8b5cf6' },
};

// 计算趋势（与前一周期比较）
function calculateTrend(current: number, previous: number): { value: number; direction: 'up' | 'down' | 'same' } {
  if (previous === 0) return { value: current > 0 ? 100 : 0, direction: current > 0 ? 'up' : 'same' };
  const change = ((current - previous) / previous) * 100;
  return {
    value: Math.abs(Math.round(change)),
    direction: change > 5 ? 'up' : change < -5 ? 'down' : 'same',
  };
}

// 生成时间段统计
function generateTimeStats(memories: MemoryItem[]): Array<{ period: string; count: number }> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // 最近 7 天每天的统计
  const dailyStats = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = now - (i + 1) * dayMs;
    const dayEnd = now - i * dayMs;
    const count = memories.filter(m => m.createdAt >= dayStart && m.createdAt < dayEnd).length;
    const date = new Date(dayEnd);
    dailyStats.push({
      period: date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }),
      count,
    });
  }

  return dailyStats;
}

// 简单柱状图组件
const SimpleBarChart: React.FC<{ data: Array<{ period: string; count: number }> }> = ({ data }) => {
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);

  return (
    <div className="flex items-end gap-1 h-20">
      {data.map((item, idx) => {
        const heightPercent = (item.count / maxCount) * 100;
        return (
          <div
            key={idx}
            className="flex-1 flex flex-col items-center gap-1 group relative"
            onMouseEnter={() => setHoveredIndex(idx)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            {/* 悬停提示 */}
            {hoveredIndex === idx && (
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-zinc-800 text-amber-400 text-xs px-2 py-1 rounded whitespace-nowrap z-10 shadow-lg border border-amber-700/30">
                ¥{item.count.toLocaleString()}
              </div>
            )}
            <div className="w-full bg-zinc-700/30 rounded-t-sm relative overflow-hidden h-16">
              <div
                className="absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-700 ease-out hover:brightness-110"
                style={{
                  height: `${heightPercent}%`,
                  background: 'linear-gradient(to top, #8B4513 0%, #D2691E 100%)',
                  animation: `growUp 0.6s ease-out ${idx * 0.1}s both`
                }}
              />
            </div>
            <span className="text-[10px] text-zinc-500">{item.period}</span>
          </div>
        );
      })}
      <style>{`
        @keyframes growUp {
          from {
            transform: scaleY(0);
            transform-origin: bottom;
          }
          to {
            transform: scaleY(1);
            transform-origin: bottom;
          }
        }
      `}</style>
    </div>
  );
};

const SimplePieChart: React.FC<{
  data: Record<MemoryCategory, number>;
  total: number;
}> = ({ data, total }) => {
  const categories = Object.entries(data) as Array<[MemoryCategory, number]>;
  let startAngle = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="w-24 h-24 shrink-0 -rotate-90">
        <circle cx="60" cy="60" r="42" fill="none" stroke="rgba(63,63,70,0.45)" strokeWidth="16" />
        {categories.map(([category, count]) => {
          if (count <= 0 || total <= 0) {
            return null;
          }

          const ratio = count / total;
          const circumference = 2 * Math.PI * 42;
          const strokeDasharray = `${ratio * circumference} ${circumference}`;
          const strokeDashoffset = -startAngle * circumference;
          startAngle += ratio;

          return (
            <circle
              key={category}
              cx="60"
              cy="60"
              r="42"
              fill="none"
              stroke={CATEGORY_CONFIG[category].color}
              strokeWidth="16"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="butt"
            />
          );
        })}
      </svg>

      <div className="flex-1 space-y-1.5">
        {categories.map(([category, count]) => (
          <div key={category} className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: CATEGORY_CONFIG[category].color }}
              />
              <span className="text-zinc-300 truncate">
                {CATEGORY_CONFIG[category].icon} {CATEGORY_CONFIG[category].label}
              </span>
            </div>
            <span className="text-zinc-500 shrink-0">
              {count}
              {total > 0 ? ` (${Math.round((count / total) * 100)}%)` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const MemoryStatsPanel: React.FC<MemoryStatsPanelProps> = ({
  memories,
  stats,
}) => {
  // 时间统计
  const timeStats = useMemo(() => generateTimeStats(memories), [memories]);

  // 本周 vs 上周对比
  const weeklyComparison = useMemo(() => {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeek = memories.filter(m => m.createdAt >= now - weekMs).length;
    const lastWeek = memories.filter(m => m.createdAt >= now - 2 * weekMs && m.createdAt < now - weekMs).length;
    return calculateTrend(thisWeek, lastWeek);
  }, [memories]);

  // 按来源统计
  const sourceStats = useMemo(() => {
    const learned = memories.filter(m => m.source === 'learned').length;
    const explicit = memories.filter(m => m.source === 'explicit').length;
    return { learned, explicit };
  }, [memories]);

  // 平均置信度
  const avgConfidence = useMemo(() => {
    const learnedMemories = memories.filter(m => m.source === 'learned');
    if (learnedMemories.length === 0) return 0;
    const sum = learnedMemories.reduce((acc, m) => acc + m.confidence, 0);
    return Math.round((sum / learnedMemories.length) * 100);
  }, [memories]);

  // 分类统计
  const categoryStats = useMemo(() => {
    const result: Record<MemoryCategory, number> = {
      about_me: 0,
      preference: 0,
      frequent_info: 0,
      learned: 0,
    };
    for (const m of memories) {
      result[m.category]++;
    }
    return result;
  }, [memories]);

  if (!stats && memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
        <BarChart3 className="w-8 h-8 mb-2" />
        <p className="text-sm">暂无统计数据</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 概览卡片 */}
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-zinc-800 rounded-lg p-2">
          <div className="flex items-center gap-1 text-zinc-400 mb-1">
            <Brain className="w-3.5 h-3.5" />
            <span className="text-xs">总记忆</span>
          </div>
          <div className="text-lg font-bold text-zinc-200">{stats?.total || memories.length}</div>
        </div>

        <div className="bg-zinc-800 rounded-lg p-2">
          <div className="flex items-center gap-1 text-zinc-400 mb-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span className="text-xs">AI 学习</span>
          </div>
          <div className="text-lg font-bold text-purple-400">{sourceStats.learned}</div>
        </div>

        <div className="bg-zinc-800 rounded-lg p-2">
          <div className="flex items-center gap-1 text-zinc-400 mb-1">
            <Calendar className="w-3.5 h-3.5" />
            <span className="text-xs">近 7 天</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-lg font-bold text-zinc-200">{stats?.recentlyAdded || timeStats.reduce((a, b) => a + b.count, 0)}</span>
            {weeklyComparison.direction !== 'same' && (
              <span className={`text-xs flex items-center ${
                weeklyComparison.direction === 'up' ? 'text-green-400' : 'text-red-400'
              }`}>
                {weeklyComparison.direction === 'up' ? (
                  <TrendingUp className="w-3 h-3" />
                ) : (
                  <TrendingDown className="w-3 h-3" />
                )}
                {weeklyComparison.value}%
              </span>
            )}
          </div>
        </div>

        <div className="bg-zinc-800 rounded-lg p-2">
          <div className="flex items-center gap-1 text-zinc-400 mb-1">
            <Activity className="w-3.5 h-3.5" />
            <span className="text-xs">置信度</span>
          </div>
          <div className="text-lg font-bold text-amber-400">{avgConfidence}%</div>
        </div>
      </div>

      {/* 每日趋势 */}
      <div className="bg-zinc-800 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">近 7 天趋势</span>
        </div>
        <SimpleBarChart data={timeStats} />
      </div>

      {/* 分类分布 */}
      <div className="bg-zinc-800 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-3">
          <PieChart className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">分类分布</span>
        </div>
        <SimplePieChart data={categoryStats} total={memories.length} />
      </div>

      {/* 来源对比 */}
      <div className="bg-zinc-800 rounded-lg p-3">
        <div className="text-sm font-medium text-zinc-200 mb-2">来源对比</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 bg-zinc-600 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500"
              style={{
                width: `${memories.length > 0 ? (sourceStats.explicit / memories.length) * 100 : 0}%`
              }}
            />
          </div>
        </div>
        <div className="flex justify-between mt-1.5 text-xs">
          <span className="text-indigo-400">手动添加 {sourceStats.explicit}</span>
          <span className="text-purple-400">AI 学习 {sourceStats.learned}</span>
        </div>
      </div>

      {/* 洞察提示 */}
      {memories.length > 0 && (
        <div className="text-xs text-zinc-500 bg-zinc-700/20 rounded-lg p-2">
          {sourceStats.learned > sourceStats.explicit ? (
            <p>💡 大部分记忆来自 AI 学习，AI 正在持续了解你的偏好和习惯。</p>
          ) : (
            <p>📝 大部分记忆是手动添加的，可以通过对话让 AI 自动学习更多。</p>
          )}
        </div>
      )}
    </div>
  );
};
