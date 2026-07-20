// ============================================================================
// MethodStage - 参数高效微调
// 介绍 LoRA/QLoRA/全量微调原理对比、显存计算
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Layers,
  Calculator,
  Cpu,
  Zap,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface MethodStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 微调方法对比
function buildMethods(t: Translations) {
  const m = t.labLlamafactory.method.methods;
  return [
    {
      id: 'full',
      ...m.full,
      en: 'Full Fine-tuning',
      vramMultiplier: 16, // 相对基准
      icon: '🏋️',
      color: 'purple',
      trainableParams: '100%',
    },
    {
      id: 'lora',
      ...m.lora,
      en: 'Low-Rank Adaptation',
      vramMultiplier: 1.2,
      icon: '🎯',
      color: 'blue',
      trainableParams: '0.1-1%',
    },
    {
      id: 'qlora',
      ...m.qlora,
      en: '4-bit LoRA',
      vramMultiplier: 0.5,
      icon: '🔧',
      color: 'emerald',
      trainableParams: '0.1-1%',
    },
  ];
}

// 模型规模选项
const modelSizes = [
  { name: '7B', params: 7, baseVram: 14 },
  { name: '13B', params: 13, baseVram: 26 },
  { name: '34B', params: 34, baseVram: 68 },
  { name: '70B', params: 70, baseVram: 140 },
];

// LoRA rank 选项
const loraRanks = [8, 16, 32, 64, 128];

// LoRA 可视化矩阵
const LoRAVisualization: React.FC<{ rank: number; originalWeightLabel: string; frozenLabel: string }> = ({ rank, originalWeightLabel, frozenLabel }) => {
  const originalDim = 100;
  const scaledRank = Math.max(4, Math.floor(rank / 8));

  return (
    <div className="flex items-center justify-center gap-4 p-4">
      {/* Original Matrix W */}
      <div className="flex flex-col items-center">
        <div
          className="bg-zinc-600 rounded border border-zinc-600"
          style={{ width: originalDim, height: originalDim }}
        >
          <div className="w-full h-full flex items-center justify-center text-xs text-zinc-400">
            W<sub>0</sub>
          </div>
        </div>
        <span className="text-xs text-zinc-500 mt-1">{originalWeightLabel}</span>
        <span className="text-xs text-zinc-600">d × d</span>
      </div>

      <span className="text-zinc-500 text-xl">=</span>

      {/* Original + Delta */}
      <div className="flex flex-col items-center">
        <div
          className="bg-zinc-600 rounded border border-zinc-600"
          style={{ width: originalDim, height: originalDim }}
        >
          <div className="w-full h-full flex items-center justify-center text-xs text-zinc-400">
            W<sub>0</sub>
          </div>
        </div>
        <span className="text-xs text-zinc-500 mt-1">{frozenLabel}</span>
      </div>

      <span className="text-zinc-500 text-xl">+</span>

      {/* B matrix */}
      <div className="flex flex-col items-center">
        <div
          className="bg-blue-500/30 rounded border border-blue-500/50"
          style={{ width: scaledRank * 2, height: originalDim }}
        >
          <div className="w-full h-full flex items-center justify-center text-xs text-blue-400">
            B
          </div>
        </div>
        <span className="text-xs text-zinc-500 mt-1">d × r</span>
      </div>

      <span className="text-zinc-500 text-xl">×</span>

      {/* A matrix */}
      <div className="flex flex-col items-center">
        <div
          className="bg-orange-500/30 rounded border border-orange-500/50"
          style={{ width: originalDim, height: scaledRank * 2 }}
        >
          <div className="w-full h-full flex items-center justify-center text-xs text-orange-400">
            A
          </div>
        </div>
        <span className="text-xs text-zinc-500 mt-1">r × d</span>
      </div>
    </div>
  );
};

export const MethodStage: React.FC<MethodStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const m = t.labLlamafactory.method;
  const methods = buildMethods(t);
  const [selectedMethod, setSelectedMethod] = useState<string>('lora');
  const [selectedModel, setSelectedModel] = useState(0); // 7B
  const [selectedRank, setSelectedRank] = useState(2); // rank=32
  const currentModel = modelSizes[selectedModel];
  const currentRank = loraRanks[selectedRank];

  // 计算显存
  const calculateVram = (methodId: string) => {
    const method = methods.find(m => m.id === methodId);
    if (!method) return 0;

    const baseVram = currentModel.baseVram;
    if (methodId === 'full') {
      return Math.round(baseVram * 1.5); // 全量微调需要更多显存存储梯度
    } else if (methodId === 'lora') {
      return Math.round(baseVram * 0.6 + currentRank * 0.02);
    } else {
      return Math.round(baseVram * 0.25 + currentRank * 0.01);
    }
  };

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; border: string; text: string }> = {
      purple: { bg: 'bg-purple-500/20', border: 'border-purple-500/30', text: 'text-purple-400' },
      blue: { bg: 'bg-blue-500/20', border: 'border-blue-500/30', text: 'text-blue-400' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/30', text: 'text-emerald-400' },
    };
    return colors[color] || colors.blue;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Layers className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{m.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {m.introDescPrefix}<span className="text-orange-400">{m.introDescHighlight}</span>{m.introDescSuffix}
            </p>
          </div>
        </div>
      </div>

      {/* Method Comparison Cards */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-orange-400" />
          {m.comparisonSectionTitle}
        </h3>
        <div className="grid grid-cols-3 gap-4">
          {methods.map((method) => {
            const isSelected = selectedMethod === method.id;
            const colors = getColorClasses(method.color);

            return (
              <button
                key={method.id}
                onClick={() => setSelectedMethod(method.id)}
                className={`
                  p-4 rounded-lg border text-left transition-all
                  ${isSelected
                    ? `${colors.bg} ${colors.border} ring-2 ring-${method.color}-500/30`
                    : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                  }
                `}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">{method.icon}</span>
                  <div>
                    <div className={`text-sm font-medium ${isSelected ? colors.text : 'text-zinc-400'}`}>
                      {method.name}
                    </div>
                    <div className="text-xs text-zinc-500">{method.en}</div>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 mb-3">{method.description}</p>

                <div className="space-y-2">
                  <div>
                    <div className="text-xs text-emerald-400 mb-1">{m.prosLabel}</div>
                    <ul className="space-y-0.5">
                      {method.pros.map((pro, idx) => (
                        <li key={idx} className="text-xs text-zinc-500 flex items-center gap-1">
                          <span className="text-emerald-400">+</span> {pro}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-xs text-red-400 mb-1">{m.consLabel}</div>
                    <ul className="space-y-0.5">
                      {method.cons.map((con, idx) => (
                        <li key={idx} className="text-xs text-zinc-500 flex items-center gap-1">
                          <span className="text-red-400">-</span> {con}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-zinc-800">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">{m.trainableParamsLabel}</span>
                    <span className={isSelected ? colors.text : 'text-zinc-400'}>{method.trainableParams}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* LoRA Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Zap className="w-4 h-4 text-orange-400" />
          {m.loraVisualizationTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <p className="text-sm text-zinc-400">
              <span className="text-blue-400 font-medium">{m.loraCoreIdeaLabel}</span>{m.loraCoreIdeaText}
            </p>
            <div className="mt-2 text-xs text-zinc-500">
              {m.loraFormulaLabel}<sub>0</sub> + ΔW ≈ W<sub>0</sub> + B × A
            </div>
          </div>

          <LoRAVisualization rank={currentRank} originalWeightLabel={m.originalWeightLabel} frozenLabel={m.frozenLabel} />

          {/* Rank Slider */}
          <div className="mt-4 p-3 rounded-lg bg-zinc-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-zinc-400">{m.loraRankLabel}</span>
              <span className="text-sm font-medium text-orange-400">{currentRank}</span>
            </div>
            <input
              type="range"
              min={0}
              max={loraRanks.length - 1}
              value={selectedRank}
              onChange={(e) => setSelectedRank(parseInt(e.target.value))}
              className="w-full h-2 bg-zinc-600 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-zinc-600 mt-1">
              {loraRanks.map((r) => (
                <span key={r}>{r}</span>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              {m.loraRankHint}
            </p>
          </div>
        </div>
      </div>

      {/* VRAM Calculator */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Calculator className="w-4 h-4 text-orange-400" />
          {m.vramCalculatorTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          {/* Model Size Selector */}
          <div className="mb-4">
            <div className="text-sm text-zinc-400 mb-2">{m.selectModelSizeLabel}</div>
            <div className="flex gap-2">
              {modelSizes.map((model, idx) => (
                <button
                  key={model.name}
                  onClick={() => setSelectedModel(idx)}
                  className={`
                    px-4 py-2 rounded-lg text-sm transition-all
                    ${selectedModel === idx
                      ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-800 hover:border-zinc-600'
                    }
                  `}
                >
                  {model.name}
                </button>
              ))}
            </div>
          </div>

          {/* VRAM Comparison */}
          <div className="grid grid-cols-3 gap-4">
            {methods.map((method) => {
              const vram = calculateVram(method.id);
              const colors = getColorClasses(method.color);
              const maxVram = calculateVram('full');
              const percentage = (vram / maxVram) * 100;

              return (
                <div key={method.id} className={`p-4 rounded-lg border ${colors.bg} ${colors.border}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <span>{method.icon}</span>
                    <span className={`text-sm font-medium ${colors.text}`}>{method.name}</span>
                  </div>
                  <div className="text-2xl font-bold text-zinc-200 mb-2">
                    {vram} GB
                  </div>
                  <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        method.id === 'full' ? 'bg-purple-500' :
                        method.id === 'lora' ? 'bg-blue-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <div className="text-xs text-zinc-500 mt-2">
                    {method.id === 'qlora' && m.qloraConsumerGpu}
                    {method.id === 'lora' && m.loraProGpu}
                    {method.id === 'full' && m.fullHighEndDevice}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Practical Advice */}
          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="text-xs text-amber-400">
              💡 {m.practicalAdvicePrefix}{currentModel.name}{m.practicalAdviceModelSuffix}
              {calculateVram('qlora') <= 24
                ? m.practicalAdviceQloraFits.replace('{vram}', String(calculateVram('qlora')))
                : m.practicalAdviceQloraNeedsMore.replace('{vram}', String(calculateVram('qlora')))
              }
            </div>
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">{m.takeawaysTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {m.takeaways.map((item) => (
            <li key={item.label} className="flex items-start gap-2">
              <span className="text-orange-400">•</span>
              <span><strong className="text-zinc-400">{item.label}</strong>：{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 专有名词 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {m.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {m.glossary.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-400">{term.zh}</span>
              </div>
              <p className="text-xs text-zinc-500">{term.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 border border-zinc-700 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          {m.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          {m.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
