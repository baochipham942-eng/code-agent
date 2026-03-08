import React, { useState } from 'react';
import { TestResultsDashboard } from '../testResults/TestResultsDashboard';

type DetailTab = 'overview' | 'cases' | 'trace' | 'scoring' | 'ai-analysis';

const TABS: Array<{ key: DetailTab; label: string }> = [
  { key: 'overview', label: '结果概览' },
  { key: 'cases', label: 'Case 列表' },
  { key: 'trace', label: 'Agent 轨迹' },
  { key: 'scoring', label: '评分详情' },
  { key: 'ai-analysis', label: 'AI 分析' },
];

export const ExperimentDetailPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3 border-b border-zinc-700/30">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-2 text-xs transition border-b-2 ${
              activeTab === tab.key
                ? 'text-zinc-200 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-300 border-transparent'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' && <TestResultsDashboard />}
        {activeTab === 'cases' && (
          <div className="p-4 text-zinc-500 text-sm">
            Case 列表视图（待接入真实数据：逐 case 结果 + 3 次 trial + 9 维度得分）
          </div>
        )}
        {activeTab === 'trace' && (
          <div className="p-4 text-zinc-500 text-sm">
            Agent 轨迹视图（将复用 AgentsView 的工具调用时间线 + Token 瀑布图 + 文件变更 Diff Viewer）
          </div>
        )}
        {activeTab === 'scoring' && (
          <div className="p-4 text-zinc-500 text-sm">
            评分详情视图（将复用 SwissCheese 的 9 维度雷达图 + LLM judge reasoning）
          </div>
        )}
        {activeTab === 'ai-analysis' && (
          <div className="p-4 text-zinc-500 text-sm">
            AI 分析视图（Claude Agent SDK 深度分析 + 改进建议 + Axial Code 关联）
          </div>
        )}
      </div>
    </div>
  );
};
