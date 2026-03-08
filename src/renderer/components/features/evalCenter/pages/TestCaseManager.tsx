import React, { useState } from 'react';
import type { TestSetTier } from '@shared/types/evaluation';

const TIERS: Array<{ key: TestSetTier; label: string; count: string }> = [
  { key: 'smoke', label: 'Smoke (10)', count: '10' },
  { key: 'core', label: 'Core (50)', count: '50' },
  { key: 'full', label: 'Full (200+)', count: '200+' },
  { key: 'benchmark', label: 'Benchmark (500+)', count: '500+' },
];

export const TestCaseManager: React.FC = () => {
  const [activeTier, setActiveTier] = useState<TestSetTier>('core');

  return (
    <div className="p-4 space-y-4">
      <h3 className="text-sm font-medium text-zinc-200">测试集管理</h3>

      {/* Tier tabs */}
      <div className="flex gap-1">
        {TIERS.map(tier => (
          <button
            key={tier.key}
            onClick={() => setActiveTier(tier.key)}
            className={`px-3 py-1.5 text-xs rounded transition ${
              activeTier === tier.key
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            {tier.label}
          </button>
        ))}
      </div>

      {/* Table header */}
      <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30">
        <div className="grid grid-cols-[1fr_100px_80px_80px_100px_80px] gap-2 px-3 py-2 text-[10px] text-zinc-500 uppercase border-b border-zinc-700/30">
          <span>Case ID</span>
          <span>分类</span>
          <span>难度</span>
          <span>来源</span>
          <span>验证器</span>
          <span>最近结果</span>
        </div>

        {/* Empty state */}
        <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
          <p className="text-sm">当前层级暂无测试用例</p>
          <p className="text-xs mt-1">
            已有 17 个 YAML 文件共 117 个 case，需按层级标记
          </p>
          <div className="mt-3 flex gap-2">
            <span className="text-xs px-2 py-1 bg-zinc-800 rounded border border-zinc-700/30">
              SWE-bench: 500 case 已下载
            </span>
            <span className="text-xs px-2 py-1 bg-zinc-800 rounded border border-zinc-700/30">
              Aider: 准备中
            </span>
          </div>
        </div>
      </div>

      {/* Source info */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'SWE-bench Verified', count: 500, color: 'text-emerald-400' },
          { label: 'Aider Polyglot', count: 225, color: 'text-blue-400' },
          { label: '内置 YAML', count: 117, color: 'text-amber-400' },
          { label: 'Production Trace', count: 0, color: 'text-zinc-400' },
        ].map(src => (
          <div key={src.label} className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
            <div className={`text-lg font-bold ${src.color}`}>{src.count}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">{src.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
