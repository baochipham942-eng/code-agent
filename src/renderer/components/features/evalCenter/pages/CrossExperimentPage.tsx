import React from 'react';

export const CrossExperimentPage: React.FC = () => {
  return (
    <div className="p-4 space-y-4">
      <h3 className="text-sm font-medium text-zinc-200">跨实验对比</h3>

      {/* Score Heatmap placeholder */}
      <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-4">
        <h4 className="text-xs font-medium text-zinc-400 mb-3">Score Heatmap</h4>
        <div className="text-zinc-500 text-sm text-center py-8">
          需要 2+ 轮评测报告后显示（行=case, 列=round, 颜色=分数）
        </div>
      </div>

      {/* Stability Report */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'pass@3', desc: '3 次中至少 1 次通过（能力上限）', value: '-' },
          { label: 'pass^3', desc: '3 次全部通过（生产可靠性）', value: '-' },
          { label: '饱和检测', desc: '连续 100% 三轮 → 升级难度', value: '-' },
        ].map(item => (
          <div key={item.label} className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-lg font-bold text-zinc-300">{item.value}</div>
            <div className="text-xs font-medium text-zinc-400 mt-1">{item.label}</div>
            <div className="text-[10px] text-zinc-600 mt-0.5">{item.desc}</div>
          </div>
        ))}
      </div>

      {/* Trend Chart placeholder */}
      <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-4">
        <h4 className="text-xs font-medium text-zinc-400 mb-3">趋势图</h4>
        <div className="text-zinc-500 text-sm text-center py-8">
          pass rate / avg score / token usage 随轮次变化趋势
        </div>
      </div>

      {/* Regression Detection */}
      <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-4">
        <h4 className="text-xs font-medium text-zinc-400 mb-3">回归检测</h4>
        <div className="text-zinc-500 text-sm text-center py-8">
          标红从 pass → fail 的 case，优先分析
        </div>
      </div>
    </div>
  );
};
