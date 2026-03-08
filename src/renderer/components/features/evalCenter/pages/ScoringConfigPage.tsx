import React, { useState } from 'react';

interface DimensionConfig {
  name: string;
  label: string;
  weight: number;
  graderType: 'code' | 'llm' | 'rule';
  description: string;
}

const DEFAULT_DIMENSIONS: DimensionConfig[] = [
  { name: 'task_completion', label: '任务完成度', weight: 30, graderType: 'code', description: 'tsc + test + golden diff' },
  { name: 'code_quality', label: '代码质量', weight: 15, graderType: 'llm', description: 'LLM judge 评估代码规范' },
  { name: 'task_understanding', label: '需求理解', weight: 15, graderType: 'llm', description: '是否正确理解需求' },
  { name: 'workflow_compliance', label: '工作流规范', weight: 10, graderType: 'rule', description: 'Read-before-Edit 等' },
  { name: 'verification', label: '验证行为', weight: 10, graderType: 'rule', description: '是否执行了验证' },
  { name: 'plan_quality', label: '方案质量', weight: 5, graderType: 'llm', description: '方案是否合理' },
  { name: 'tool_selection', label: '工具选择', weight: 5, graderType: 'rule', description: '用 Read 还是 cat' },
  { name: 'self_repair', label: '自修复', weight: 5, graderType: 'rule', description: '遇到错误是否自修复' },
  { name: 'efficiency', label: '效率', weight: 5, graderType: 'rule', description: 'Token/时间/工具调用' },
];

const GRADER_COLORS: Record<string, string> = {
  code: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  llm: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  rule: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

export const ScoringConfigPage: React.FC = () => {
  const [dimensions, setDimensions] = useState(DEFAULT_DIMENSIONS);

  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">评分维度配置</h3>
        <div className={`text-xs ${totalWeight === 100 ? 'text-emerald-400' : 'text-red-400'}`}>
          权重总计: {totalWeight}%
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-3">
        {Object.entries({ code: '确定性验证', llm: 'LLM Judge', rule: '规则检测' }).map(([type, label]) => (
          <span key={type} className={`text-[10px] px-2 py-0.5 rounded border ${GRADER_COLORS[type]}`}>
            {label}
          </span>
        ))}
      </div>

      {/* Dimension list */}
      <div className="space-y-2">
        {dimensions.map((dim, idx) => (
          <div key={dim.name} className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
            <div className="flex items-center gap-3">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${GRADER_COLORS[dim.graderType]}`}>
                {dim.graderType}
              </span>
              <span className="text-sm text-zinc-200 font-medium flex-1">{dim.label}</span>
              <span className="text-xs text-zinc-500 mr-2">{dim.description}</span>
              <div className="flex items-center gap-2 w-32">
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={dim.weight}
                  onChange={(e) => {
                    const updated = [...dimensions];
                    updated[idx] = { ...dim, weight: parseInt(e.target.value) };
                    setDimensions(updated);
                  }}
                  className="flex-1 h-1 appearance-none bg-zinc-700 rounded-full cursor-pointer"
                />
                <span className="text-xs text-zinc-300 w-8 text-right font-mono">{dim.weight}%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Presets */}
      <div className="border-t border-zinc-700/30 pt-3">
        <p className="text-xs text-zinc-500 mb-2">预设方案</p>
        <div className="flex gap-2">
          {['安全优先', '质量优先', '效率优先', 'ExcelMaster 默认'].map(preset => (
            <button key={preset} className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/30 rounded transition">
              {preset}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
