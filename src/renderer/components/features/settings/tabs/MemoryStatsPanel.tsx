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

  return (
    <div className="flex items-end gap-1 h-20">
      {data.map((item, index) => (
        <div key={index} className="flex-1 flex flex-col items-center">
          <div
            className="w-full bg-indigo-500/50 rounded-t transition-all hover:bg-indigo-500/70"
            style={{ height: `${(item.count / maxCount) * 100}%`, minHeight: item.count > 0 ? '4px' : '2px' }}
            title={`${item.period}: ${item.count} 条`}
          />
          <span className="text-[10px] text-text-tertiary mt-1 truncate w-full text-center">
            {item.period.replace('月', '/')}
          </span>
        </div>
      ))}
    </div>
  );
};

// 简单饼图组件（使用 CSS 渐变）
const SimplePieChart: React.FC<{ data: Record<MemoryCategory, number>; total: number }> = ({ data, total }) => {
  const categories = Object.keys(data) as MemoryCategory[];
  let cumulativePercent = 0;

  const gradientStops = categories.map(cat => {
    const percent = total > 0 ? (data[cat] / total) * 100 : 0;
    const start = cumulativePercent;
    cumulativePercent += percent;
    return { category: cat, start, end: cumulativePercent, percent };
  });

  const conicGradient = gradientStops
    .map(s => `${CATEGORY_CONFIG[s.category].color} ${s.start}% ${s.end}%`)
    .join(', ');

  return (
    <div className="flex items-center gap-4">
      <div
        className="w-16 h-16 rounded-full"
        style={{
          background: total > 0
            ? `conic-gradient(${conicGradient})`
            : '#27272a',
        }}
      />
      <div className="flex-1 space-y-1">
        {gradientStops.map(s => (
          <div key={s.category} className="flex items-center gap-2 text-xs">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: CATEGORY_CONFIG[s.category].color }}
            />
            <span className="text-text-secondary">{CATEGORY_CONFIG[s.category].label}</span>
            <span className="text-text-secondary ml-auto">{data[s.category]}</span>
            <span className="text-text-tertiary w-10 text-right">
              {Math.round(s.percent)}%
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
      <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
        <BarChart3 className="w-8 h-8 mb-2" />
        <p className="text-sm">暂无统计数据</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 概览卡片 */}
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-surface rounded-lg p-2">
          <div className="flex items-center gap-1 text-text-secondary mb-1">
            <Brain className="w-3.5 h-3.5" />
            <span className="text-xs">总记忆</span>
          </div>
          <div className="text-lg font-bold text-text-primary">{stats?.total || memories.length}</div>
        </div>

        <div className="bg-surface rounded-lg p-2">
          <div className="flex items-center gap-1 text-text-secondary mb-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span className="text-xs">AI 学习</span>
          </div>
          <div className="text-lg font-bold text-purple-400">{sourceStats.learned}</div>
        </div>

        <div className="bg-surface rounded-lg p-2">
          <div className="flex items-center gap-1 text-text-secondary mb-1">
            <Calendar className="w-3.5 h-3.5" />
            <span className="text-xs">近 7 天</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-lg font-bold text-text-primary">{stats?.recentlyAdded || timeStats.reduce((a, b) => a + b.count, 0)}</span>
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

        <div className="bg-surface rounded-lg p-2">
          <div className="flex items-center gap-1 text-text-secondary mb-1">
            <Activity className="w-3.5 h-3.5" />
            <span className="text-xs">置信度</span>
          </div>
          <div className="text-lg font-bold text-amber-400">{avgConfidence}%</div>
        </div>
      </div>

      {/* 每日趋势 */}
      <div className="bg-surface rounded-lg p-3">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">近 7 天趋势</span>
        </div>
        <SimpleBarChart data={timeStats} />
      </div>

      {/* 分类分布 */}
      <div className="bg-surface rounded-lg p-3">
        <div className="flex items-center gap-2 mb-3">
          <PieChart className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">分类分布</span>
        </div>
        <SimplePieChart data={categoryStats} total={memories.length} />
      </div>

      {/* 来源对比 */}
      <div className="bg-surface rounded-lg p-3">
        <div className="text-sm font-medium text-text-primary mb-2">来源对比</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 bg-active rounded-full overflow-hidden">
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
        <div className="text-xs text-text-tertiary bg-elevated/20 rounded-lg p-2">
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
