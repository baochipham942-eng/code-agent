// ============================================================================
// ModelArchitecture - nanoGPT 模型架构阶段
// 用通俗方式介绍 AI 的「大脑」结构
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, Brain, Layers, ArrowRight } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

interface ModelArchitectureProps {
  onComplete: () => void;
  onBack: () => void;
}

type ModelSize = 'small' | 'medium' | 'large' | 'xl';

export const ModelArchitecture: React.FC<ModelArchitectureProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const ma = t.labNanogpt.modelArchitecture;
  const modelSizes: Record<ModelSize, { name: string; params: string; layers: number; heads: number; dModel: number; analogy: string }> = {
    small: { ...ma.sizes.small, layers: 12, heads: 12, dModel: 768 },
    medium: { ...ma.sizes.medium, layers: 24, heads: 16, dModel: 1024 },
    large: { ...ma.sizes.large, layers: 36, heads: 20, dModel: 1280 },
    xl: { ...ma.sizes.xl, layers: 48, heads: 25, dModel: 1600 },
  };
  const [selectedSize, setSelectedSize] = useState<ModelSize>('small');
  const model = modelSizes[selectedSize];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* 概念说明 */}
      <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-lg border border-purple-500/20 p-4">
        <div className="flex items-start gap-3">
          <Brain className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{ma.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {ma.introBody}
            </p>
          </div>
        </div>
      </div>

      {/* 大脑工作原理 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{ma.howLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-3xl mb-2">👁️</div>
              <div className="text-sm font-medium text-emerald-400">{ma.step1Title}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.step1Desc}</div>
            </div>
            <div className="text-center p-4 bg-blue-500/10 rounded-lg border border-blue-500/20">
              <div className="text-3xl mb-2">🤔</div>
              <div className="text-sm font-medium text-blue-400">{ma.step2Title}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.step2Desc}</div>
            </div>
            <div className="text-center p-4 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-3xl mb-2">💬</div>
              <div className="text-sm font-medium text-purple-400">{ma.step3Title}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.step3Desc}</div>
            </div>
          </div>

          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <span className="text-lg">💡</span>
              <span>{ma.howFooter}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Model Size Selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{ma.sizeLabel}</h3>
        <div className="grid grid-cols-4 gap-3">
          {(Object.entries(modelSizes) as [ModelSize, typeof modelSizes.small][]).map(([key, size]) => (
            <button
              key={key}
              onClick={() => setSelectedSize(key)}
              className={`p-4 rounded-lg border text-left transition-all ${
                selectedSize === key
                  ? 'bg-blue-500/10 border-blue-500/50'
                  : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
              }`}
            >
              <div className="text-sm font-medium text-zinc-200 mb-1">{size.name}{ma.brainSuffix}</div>
              <div className="text-lg font-bold text-blue-400">{size.params} {ma.neuronSuffix}</div>
              <div className="text-xs text-zinc-500 mt-2">
                {size.layers} {ma.layersSuffix} · {size.heads} {ma.headsSuffix}
              </div>
              <div className="text-xs text-emerald-400/70 mt-1">
                {size.analogy}
              </div>
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-500 text-center">
          {ma.sizeFooter}
        </p>
      </div>

      {/* Architecture Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{ma.vizLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-6">
          <div className="flex items-center justify-center gap-3">
            {/* Input Embedding */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-20 bg-gradient-to-b from-emerald-500/20 to-emerald-500/5 border border-emerald-500/30 rounded-lg flex flex-col items-center justify-center">
                <span className="text-2xl">👁️</span>
                <span className="text-xs text-emerald-400 mt-1">{ma.embedLabel}</span>
              </div>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-500" />

            {/* Transformer Blocks */}
            <div className="flex flex-col items-center gap-2">
              <div className="relative">
                <div className="w-36 h-20 bg-gradient-to-b from-blue-500/20 to-blue-500/5 border border-blue-500/30 rounded-lg flex flex-col items-center justify-center">
                  <Layers className="w-5 h-5 text-blue-400 mb-1" />
                  <span className="text-xs text-blue-400">{ma.transformerLabel}</span>
                </div>
                <div className="absolute -bottom-3 left-1/2 transform -translate-x-1/2 px-3 py-1 bg-blue-500/20 rounded-full text-xs text-blue-400 font-medium">
                  × {model.layers} {ma.layersCountSuffix}
                </div>
              </div>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-500" />

            {/* Output */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-20 bg-gradient-to-b from-purple-500/20 to-purple-500/5 border border-purple-500/30 rounded-lg flex flex-col items-center justify-center">
                <span className="text-2xl">💬</span>
                <span className="text-xs text-purple-400 mt-1">{ma.outputLabel}</span>
              </div>
            </div>
          </div>

          <div className="mt-6 text-center text-xs text-zinc-500">
            {ma.vizFooterPart1}{model.name}{ma.vizFooterPart2}<span className="text-blue-400 font-bold">{model.layers}</span>{ma.vizFooterPart3}
            <span className="text-blue-400 font-bold">{model.heads}</span>{ma.vizFooterPart4}
          </div>
        </div>
      </div>

      {/* 什么是「关注点」 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{ma.attentionLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <p className="text-sm text-zinc-400 mb-4">
            {ma.attentionIntro}
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
              <div className="text-sm text-blue-400 font-medium mb-1">{ma.attention1Label}</div>
              <div className="text-xs text-zinc-500">{ma.attention1Desc}</div>
            </div>
            <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-sm text-emerald-400 font-medium mb-1">{ma.attention2Label}</div>
              <div className="text-xs text-zinc-500">{ma.attention2Desc}</div>
            </div>
            <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-sm text-purple-400 font-medium mb-1">{ma.attention3Label}</div>
              <div className="text-xs text-zinc-500">{ma.attention3Desc}</div>
            </div>
          </div>
          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="text-xs text-amber-400">
              {ma.attentionFooter}
            </div>
          </div>
        </div>
      </div>

      {/* 总结 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{ma.summaryLabel}</h3>
        <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-lg border border-blue-500/20 p-4">
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-blue-400">{model.params}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.summaryNeuronsLabel}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">{model.layers}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.summaryLayersLabel}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-purple-400">{model.heads}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.summaryHeadsLabel}</div>
            </div>
            <div>
              <div className="text-lg font-medium text-amber-400">{model.analogy}</div>
              <div className="text-xs text-zinc-500 mt-1">{ma.summaryAnalogyLabel}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {ma.glossaryLabel}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ma.glossary.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-400">{term.label}</span>
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
          {ma.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all font-medium"
        >
          {ma.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
