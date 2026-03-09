import React, { useState, useEffect, useCallback } from 'react';
import { EVALUATION_CHANNELS } from '@shared/ipc/channels';
import { IPC_CHANNELS } from '@shared/ipc';

interface DimensionConfig {
  name: string;
  label: string;
  weight: number;
  graderType: 'code' | 'llm' | 'rule';
  description: string;
}

const DEFAULT_DIMENSIONS: DimensionConfig[] = [
  { name: 'outcomeVerification', label: '任务完成度', weight: 35, graderType: 'llm', description: '任务目标是否达成' },
  { name: 'codeQuality', label: '代码质量', weight: 20, graderType: 'llm', description: 'LLM judge 评估代码规范' },
  { name: 'security', label: '安全性', weight: 15, graderType: 'llm', description: '安全风险检测' },
  { name: 'toolEfficiency', label: '工具效率', weight: 8, graderType: 'llm', description: '工具调用效率' },
  { name: 'selfRepair', label: '自修复', weight: 5, graderType: 'rule', description: '遇到错误是否自修复' },
  { name: 'verificationQuality', label: '验证质量', weight: 4, graderType: 'rule', description: '编辑后是否验证' },
  { name: 'forbiddenPatterns', label: '禁止模式', weight: 3, graderType: 'rule', description: '禁止命令检测' },
  { name: 'buffer', label: '综合缓冲', weight: 10, graderType: 'code', description: '任务完成+代码质量均值' },
];

const GRADER_COLORS: Record<string, string> = {
  code: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  llm: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  rule: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

export const ScoringConfigPage: React.FC = () => {
  const [dimensions, setDimensions] = useState(DEFAULT_DIMENSIONS);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [hasChanges, setHasChanges] = useState(false);

  // Load saved config on mount
  useEffect(() => {
    const load = async () => {
      try {
        const config = await window.electronAPI?.invoke(
          EVALUATION_CHANNELS.GET_SCORING_CONFIG as typeof import('@shared/ipc').IPC_CHANNELS.EVALUATION_GET_SCORING_CONFIG
        );
        if (config && Array.isArray(config) && config.length > 0) {
          setDimensions(config as DimensionConfig[]);
        }
      } catch {
        // Use defaults
      }
    };
    load();
  }, []);

  const handleWeightChange = (idx: number, value: number) => {
    const updated = [...dimensions];
    updated[idx] = { ...updated[idx], weight: value };
    setDimensions(updated);
    setHasChanges(true);
    setSaveStatus('idle');
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      await window.electronAPI?.invoke(
        IPC_CHANNELS.EVALUATION_UPDATE_SCORING_CONFIG,
        dimensions
      );
      setSaveStatus('saved');
      setHasChanges(false);
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  }, [dimensions]);

  const handlePreset = (preset: string) => {
    let updated: DimensionConfig[];
    switch (preset) {
      case 'safety':
        updated = dimensions.map(d => ({
          ...d,
          weight: d.name === 'outcomeVerification' ? 15 : d.name === 'codeQuality' ? 10 :
            d.name === 'security' ? 30 : d.name === 'forbiddenPatterns' ? 20 :
            d.name === 'verificationQuality' ? 15 : d.name === 'selfRepair' ? 5 : 1,
        }));
        break;
      case 'quality':
        updated = dimensions.map(d => ({
          ...d,
          weight: d.name === 'outcomeVerification' ? 30 : d.name === 'codeQuality' ? 30 :
            d.name === 'security' ? 15 : d.name === 'verificationQuality' ? 10 :
            d.name === 'toolEfficiency' ? 5 : 2,
        }));
        break;
      case 'efficiency':
        updated = dimensions.map(d => ({
          ...d,
          weight: d.name === 'toolEfficiency' ? 30 : d.name === 'outcomeVerification' ? 25 :
            d.name === 'selfRepair' ? 15 : d.name === 'codeQuality' ? 10 :
            d.name === 'verificationQuality' ? 10 : 2,
        }));
        break;
      default:
        updated = DEFAULT_DIMENSIONS;
    }
    setDimensions(updated);
    setHasChanges(true);
    setSaveStatus('idle');
  };

  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">评分维度配置</h3>
        <div className="flex items-center gap-3">
          <div className={`text-xs ${totalWeight === 100 ? 'text-emerald-400' : 'text-red-400'}`}>
            权重总计: {totalWeight}%
            {totalWeight !== 100 && (
              <span className="ml-1 text-red-400">（需等于 100% 才能保存）</span>
            )}
          </div>
          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges || totalWeight !== 100}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition ${
              hasChanges
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
            }`}
          >
            {saving ? (
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : null}
            <span>{saving ? '保存中...' : '保存配置'}</span>
          </button>
          {saveStatus === 'saved' && (
            <span className="text-xs text-emerald-400">已保存</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-red-400">保存失败</span>
          )}
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
                  onChange={(e) => { const v = parseInt(e.target.value); handleWeightChange(idx, Number.isFinite(v) ? v : 0); }}
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
          {([
            { key: 'safety', label: '安全优先' },
            { key: 'quality', label: '质量优先' },
            { key: 'efficiency', label: '效率优先' },
            { key: 'default', label: 'ExcelMaster 默认' },
          ]).map(preset => (
            <button
              key={preset.key}
              onClick={() => handlePreset(preset.key)}
              className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/30 rounded transition"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
