// ============================================================================
// MemoryKnowledgeGraph - 记忆知识图谱可视化
// 以图谱形式展示 AI 协作学习成果：工作模式、能力使用、成功经验等
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Brain,
  Sparkles,
  TrendingUp,
  ChevronRight,
  RefreshCw,
  Loader2,
  Lightbulb,
  FileText,
  Globe,
  Image,
  Presentation,
  MessageSquare,
  Search,
  FolderOpen,
  Zap,
  Target,
  Award,
} from 'lucide-react';
import { Button } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('MemoryKnowledgeGraph');

// ============================================================================
// Types
// ============================================================================

interface ToolPreference {
  name: string;
  count: number;
  percentage: number;
}

interface EvolutionPattern {
  name: string;
  type: string;
  context: string;
  pattern: string;
  solution: string;
  confidence: number;
  occurrences: number;
  tags: string[];
}

interface LearningInsights {
  toolPreferences: ToolPreference[];
  codingStyle: unknown; // 不再使用
  evolutionPatterns: EvolutionPattern[];
  totalToolUsage: number;
  topTools: string[];
}

// 能力分类
interface CapabilityCategory {
  id: string;
  name: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  tools: string[];
  description: string;
}

// 能力分类定义 - 按协作场景划分
const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  {
    id: 'research',
    name: '信息检索',
    icon: <Search className="w-4 h-4" />,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/20',
    tools: ['web_search', 'web_fetch', 'read_pdf', 'youtube_transcript', 'mcp', 'mcp_list_tools'],
    description: '搜索网络、获取文档、提取信息',
  },
  {
    id: 'content',
    name: '内容创作',
    icon: <FileText className="w-4 h-4" />,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20',
    tools: ['write_file', 'edit_file', 'ppt_generate', 'image_generate'],
    description: '撰写文档、生成PPT、创建图片',
  },
  {
    id: 'analysis',
    name: '分析理解',
    icon: <FolderOpen className="w-4 h-4" />,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    tools: ['read_file', 'glob', 'list_directory', 'grep'],
    description: '阅读文件、分析结构、理解内容',
  },
  {
    id: 'execution',
    name: '任务执行',
    icon: <Zap className="w-4 h-4" />,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    tools: ['bash', 'todo_write', 'plan_read', 'plan_update', 'enter_plan_mode', 'exit_plan_mode'],
    description: '执行命令、管理任务、规划流程',
  },
];

// 工具友好名称映射
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_search: '网络搜索',
  web_fetch: '网页抓取',
  read_pdf: 'PDF 阅读',
  youtube_transcript: '视频字幕',
  mcp: 'MCP 调用',
  mcp_list_tools: 'MCP 工具',
  write_file: '写入文件',
  edit_file: '编辑文件',
  ppt_generate: 'PPT 生成',
  image_generate: '图片生成',
  read_file: '读取文件',
  glob: '文件搜索',
  list_directory: '目录浏览',
  grep: '内容搜索',
  bash: '命令执行',
  todo_write: '任务管理',
  plan_read: '读取计划',
  plan_update: '更新计划',
  enter_plan_mode: '进入规划',
  exit_plan_mode: '退出规划',
  learn_pattern: '学习模式',
};

// ============================================================================
// Sub Components
// ============================================================================

/**
 * 能力雷达图 - 展示各能力分类的使用情况
 */
const CapabilityRadar: React.FC<{
  categories: Array<{ category: CapabilityCategory; count: number; percentage: number }>;
}> = ({ categories }) => {
  const angleStep = (2 * Math.PI) / categories.length;
  const centerX = 120;
  const centerY = 120;
  const maxRadius = 90;

  // 计算各点位置
  const maxCount = Math.max(...categories.map(c => c.count), 1);
  const points = categories.map((item, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const radius = (item.count / maxCount) * maxRadius * 0.85;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      labelX: centerX + Math.cos(angle) * (maxRadius + 20),
      labelY: centerY + Math.sin(angle) * (maxRadius + 20),
      item,
      angle,
    };
  });

  const polygonPoints = points.map(p => `${p.x},${p.y}`).join(' ');

  return (
    <div className="relative">
      <svg viewBox="0 0 240 240" className="w-full h-56">
        {/* 背景圈 */}
        {[0.25, 0.5, 0.75, 1].map((scale, i) => (
          <circle
            key={i}
            cx={centerX}
            cy={centerY}
            r={maxRadius * scale}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            className="text-zinc-700/40"
          />
        ))}

        {/* 射线和标签 */}
        {points.map((p, i) => (
          <g key={i}>
            <line
              x1={centerX}
              y1={centerY}
              x2={centerX + Math.cos(p.angle) * maxRadius}
              y2={centerY + Math.sin(p.angle) * maxRadius}
              stroke="currentColor"
              strokeWidth="1"
              className="text-zinc-700/40"
            />
          </g>
        ))}

        {/* 数据多边形 */}
        <polygon
          points={polygonPoints}
          fill="url(#capabilityGradient)"
          stroke="currentColor"
          strokeWidth="2"
          className="text-indigo-400"
        />

        {/* 渐变定义 */}
        <defs>
          <linearGradient id="capabilityGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgb(99, 102, 241)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="rgb(139, 92, 246)" stopOpacity="0.4" />
          </linearGradient>
        </defs>

        {/* 数据点 */}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r="5"
            className={p.item.category.color.replace('text-', 'fill-')}
          />
        ))}
      </svg>

      {/* 标签 */}
      <div className="absolute inset-0 pointer-events-none">
        {points.map((p, i) => {
          const isLeft = p.labelX < centerX;
          const isTop = p.labelY < centerY;
          return (
            <div
              key={i}
              className="absolute flex items-center gap-1"
              style={{
                left: `${(p.labelX / 240) * 100}%`,
                top: `${(p.labelY / 240) * 100}%`,
                transform: `translate(${isLeft ? '-100%' : '0'}, ${isTop ? '-100%' : '0'})`,
              }}
            >
              <span className={`${p.item.category.color}`}>{p.item.category.icon}</span>
              <span className="text-xs text-zinc-300">{p.item.category.name}</span>
              <span className="text-xs text-zinc-500">({p.item.count})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * 能力卡片
 */
const CapabilityCard: React.FC<{
  category: CapabilityCategory;
  tools: ToolPreference[];
  totalInCategory: number;
}> = ({ category, tools, totalInCategory }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (tools.length === 0) return null;

  const maxCount = Math.max(...tools.map(t => t.count), 1);

  return (
    <div className={`border border-zinc-700/50 rounded-lg overflow-hidden`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-full flex items-center gap-3 p-3 ${category.bgColor} hover:brightness-110 transition-all text-left`}
      >
        <div className={category.color}>{category.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">{category.name}</span>
            <span className="text-xs text-zinc-500">{totalInCategory} 次调用</span>
          </div>
          <p className="text-xs text-zinc-500 truncate">{category.description}</p>
        </div>
        <ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
      </button>

      {isExpanded && (
        <div className="p-3 space-y-2 bg-zinc-800/30">
          {tools.map((tool) => (
            <div key={tool.name} className="flex items-center gap-2">
              <span className="text-xs text-zinc-400 w-20 truncate">
                {TOOL_DISPLAY_NAMES[tool.name] || tool.name}
              </span>
              <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${category.bgColor.replace('/20', '/60')}`}
                  style={{ width: `${(tool.count / maxCount) * 100}%` }}
                />
              </div>
              <span className="text-xs text-zinc-500 w-8 text-right">{tool.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 成功经验卡片
 */
const PatternCard: React.FC<{ pattern: EvolutionPattern }> = ({ pattern }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-purple-500/30 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-start gap-3 p-3 bg-purple-500/10 hover:bg-purple-500/15 transition-colors text-left"
      >
        <div className="mt-0.5">
          <Award className="w-4 h-4 text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-200">{pattern.name}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
              成功经验
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{pattern.context}</p>
        </div>
        <ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
      </button>

      {isExpanded && (
        <div className="p-3 space-y-3 bg-zinc-800/30">
          <div>
            <div className="text-xs text-zinc-500 mb-1">场景</div>
            <p className="text-sm text-zinc-300">{pattern.context}</p>
          </div>
          <div>
            <div className="text-xs text-zinc-500 mb-1">方法</div>
            <p className="text-sm text-zinc-300">{pattern.pattern}</p>
          </div>
          <div>
            <div className="text-xs text-zinc-500 mb-1">步骤</div>
            <p className="text-sm text-zinc-300 whitespace-pre-line">{pattern.solution}</p>
          </div>
          <div className="flex items-center gap-4 pt-2 border-t border-zinc-700/50">
            <span className="text-xs text-zinc-500">
              置信度 <span className="text-purple-400">{Math.round(pattern.confidence * 100)}%</span>
            </span>
          </div>
          {pattern.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pattern.tags.map((tag, i) => (
                <span key={i} className="text-xs px-1.5 py-0.5 bg-zinc-700/50 text-zinc-400 rounded">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 协作图谱中心视图
 */
const CoworkGraphView: React.FC<{
  categoryStats: Array<{ category: CapabilityCategory; count: number; percentage: number }>;
  patternCount: number;
  totalUsage: number;
}> = ({ categoryStats, patternCount, totalUsage }) => {
  // 按使用量排序的分类
  const sortedCategories = [...categoryStats].sort((a, b) => b.count - a.count);
  const topCategories = sortedCategories.filter(c => c.count > 0).slice(0, 4);

  return (
    <div className="relative py-4">
      {/* 中心节点 */}
      <div className="flex justify-center mb-6">
        <div className="relative">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Brain className="w-9 h-9 text-white" />
          </div>
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300 whitespace-nowrap">
            AI 协作
          </div>
        </div>
      </div>

      {/* 能力分支 */}
      <div className="grid grid-cols-2 gap-3">
        {topCategories.map((item) => (
          <div
            key={item.category.id}
            className={`flex items-center gap-2 p-2.5 rounded-lg ${item.category.bgColor} border border-zinc-700/30`}
          >
            <div className={item.category.color}>{item.category.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-200">{item.category.name}</div>
              <div className="text-[10px] text-zinc-500">{item.count} 次 · {Math.round(item.percentage)}%</div>
            </div>
          </div>
        ))}
      </div>

      {/* 统计摘要 */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="text-center p-2 bg-zinc-800/40 rounded-lg">
          <div className="text-lg font-bold text-indigo-400">{totalUsage}</div>
          <div className="text-[10px] text-zinc-500">总协作次数</div>
        </div>
        <div className="text-center p-2 bg-zinc-800/40 rounded-lg">
          <div className="text-lg font-bold text-emerald-400">{topCategories.length}</div>
          <div className="text-[10px] text-zinc-500">活跃能力</div>
        </div>
        <div className="text-center p-2 bg-zinc-800/40 rounded-lg">
          <div className="text-lg font-bold text-purple-400">{patternCount}</div>
          <div className="text-[10px] text-zinc-500">成功经验</div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const MemoryKnowledgeGraph: React.FC = () => {
  const [insights, setInsights] = useState<LearningInsights | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'capabilities' | 'patterns'>('overview');

  // 加载学习洞察
  const loadInsights = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
        action: 'getLearningInsights',
      }) as { success: boolean; data?: LearningInsights; error?: string };

      if (result?.success && result.data) {
        setInsights(result.data);
      } else {
        setError(result?.error || '加载失败');
      }
    } catch (err) {
      logger.error('Failed to load learning insights', err);
      setError('加载学习数据失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  // 按能力分类统计工具使用
  const categoryStats = useMemo(() => {
    if (!insights) return [];

    return CAPABILITY_CATEGORIES.map(category => {
      const toolsInCategory = insights.toolPreferences.filter(t =>
        category.tools.includes(t.name)
      );
      const count = toolsInCategory.reduce((sum, t) => sum + t.count, 0);
      return {
        category,
        tools: toolsInCategory.sort((a, b) => b.count - a.count),
        count,
        percentage: insights.totalToolUsage > 0 ? (count / insights.totalToolUsage) * 100 : 0,
      };
    });
  }, [insights]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-zinc-500">{error}</p>
        <Button variant="ghost" size="sm" onClick={loadInsights} className="mt-2">
          <RefreshCw className="w-4 h-4 mr-1" />
          重试
        </Button>
      </div>
    );
  }

  // Empty state
  if (!insights || insights.totalToolUsage === 0) {
    return (
      <div className="text-center py-12">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-800/50 flex items-center justify-center">
          <Brain className="w-8 h-8 text-zinc-500" />
        </div>
        <h4 className="text-zinc-200 font-medium mb-1">暂无协作数据</h4>
        <p className="text-sm text-zinc-500">
          开始与 AI 协作后，这里将展示学习成果
        </p>
      </div>
    );
  }

  const hasPatterns = insights.evolutionPatterns.length > 0;
  const tabs = [
    { id: 'overview', label: '概览', icon: <Brain className="w-4 h-4" /> },
    { id: 'capabilities', label: '能力', icon: <Target className="w-4 h-4" /> },
    { id: 'patterns', label: '经验', icon: <Lightbulb className="w-4 h-4" />, count: insights.evolutionPatterns.length, disabled: !hasPatterns },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-400" />
          <h3 className="text-sm font-medium text-zinc-200">协作学习图谱</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={loadInsights} className="p-1.5">
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-zinc-800/30 rounded-lg p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => !tab.disabled && setActiveTab(tab.id as typeof activeTab)}
            disabled={tab.disabled}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-zinc-700 text-zinc-100'
                : tab.disabled
                ? 'text-zinc-600 cursor-not-allowed'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="text-[10px] text-zinc-500">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="bg-zinc-800/30 rounded-lg p-4">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            {/* 协作图谱 */}
            <CoworkGraphView
              categoryStats={categoryStats}
              patternCount={insights.evolutionPatterns.length}
              totalUsage={insights.totalToolUsage}
            />

            {/* 洞察提示 */}
            {categoryStats.filter(c => c.count > 0).length > 0 && (
              <div className="text-xs text-zinc-500 bg-zinc-800/50 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                  <div>
                    {(() => {
                      const top = categoryStats.sort((a, b) => b.count - a.count)[0];
                      if (top && top.count > 0) {
                        return (
                          <p>
                            你最常使用的协作能力是<span className={`font-medium ${top.category.color}`}>{top.category.name}</span>
                            ，共 {top.count} 次调用，占总协作的 {Math.round(top.percentage)}%。
                          </p>
                        );
                      }
                      return <p>开始更多协作，AI 将学习你的工作习惯。</p>;
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'capabilities' && (
          <div className="space-y-4">
            {/* 能力雷达图 */}
            <CapabilityRadar categories={categoryStats.filter(c => c.count > 0)} />

            {/* 能力详情列表 */}
            <div className="space-y-2">
              {categoryStats
                .filter(c => c.count > 0)
                .sort((a, b) => b.count - a.count)
                .map((item) => (
                  <CapabilityCard
                    key={item.category.id}
                    category={item.category}
                    tools={item.tools}
                    totalInCategory={item.count}
                  />
                ))}
            </div>
          </div>
        )}

        {activeTab === 'patterns' && (
          <div className="space-y-3">
            <div className="text-xs text-zinc-500 mb-2">
              AI 从成功协作中总结的经验，可复用于类似场景
            </div>
            {insights.evolutionPatterns.length > 0 ? (
              insights.evolutionPatterns.map((pattern, i) => (
                <PatternCard key={i} pattern={pattern} />
              ))
            ) : (
              <p className="text-sm text-zinc-500 text-center py-8">暂无成功经验</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
