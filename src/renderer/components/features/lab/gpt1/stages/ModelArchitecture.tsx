// ============================================================================
// ModelArchitecture - 阶段 3: 模型架构
// 展示 GPT-1 Transformer 结构，可视化各层组件
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, Layers, Box, Zap, Info } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

// 模型配置
const modelConfig = {
  vocabSize: 280,
  blockSize: 128,
  nLayer: 6,
  nHead: 6,
  nEmbd: 384,
};

// 参数计算
const paramCounts = {
  tokenEmb: modelConfig.vocabSize * modelConfig.nEmbd,
  posEmb: modelConfig.blockSize * modelConfig.nEmbd,
  perBlock: {
    attn: 4 * modelConfig.nEmbd * modelConfig.nEmbd, // Q, K, V, O projections
    ffn: 2 * modelConfig.nEmbd * (4 * modelConfig.nEmbd), // up + down
    layerNorm: 4 * modelConfig.nEmbd, // 2 layer norms
  },
  outputProj: modelConfig.nEmbd * modelConfig.vocabSize,
};

const totalPerBlock = paramCounts.perBlock.attn + paramCounts.perBlock.ffn + paramCounts.perBlock.layerNorm;
const totalParams = paramCounts.tokenEmb + paramCounts.posEmb + (totalPerBlock * modelConfig.nLayer) + paramCounts.outputProj;

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

type SelectedLayer = 'embedding' | 'attention' | 'ffn' | 'output' | null;

export const ModelArchitecture: React.FC<Props> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const ma = t.labGpt1.modelArchitecture;
  const [selectedLayer, setSelectedLayer] = useState<SelectedLayer>(null);

  // 层详情内容 - 用通俗的比喻解释
  const layerDetails: Record<NonNullable<SelectedLayer>, { title: string; description: string; analogy: string; simple: string }> = {
    embedding: {
      ...ma.layers.embedding,
      simple: ma.layers.embedding.simple.replace('{count}', String(modelConfig.nEmbd)),
    },
    attention: {
      ...ma.layers.attention,
      simple: ma.layers.attention.simple.replace('{count}', String(modelConfig.nHead)),
    },
    ffn: ma.layers.ffn,
    output: {
      ...ma.layers.output,
      simple: ma.layers.output.simple.replace('{count}', String(modelConfig.vocabSize)),
    },
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：架构可视化 */}
        <div className="space-y-6">
          {/* 架构图 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              {ma.diagramTitle}
            </h3>

            <div className="space-y-3">
              {/* Input */}
              <div className="text-center text-xs text-zinc-500 mb-2">
                {ma.diagramInput.replace('{count}', String(modelConfig.blockSize))}
              </div>

              {/* Embedding Layer */}
              <button
                onClick={() => setSelectedLayer('embedding')}
                className={`w-full p-3 rounded-lg border transition-all ${
                  selectedLayer === 'embedding'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <div className="text-sm font-medium">{ma.embeddingButtonTitle}</div>
                <div className="text-xs text-zinc-500 mt-1">
                  {ma.embeddingButtonSub.replace('{count}', String(modelConfig.nEmbd))}
                </div>
              </button>

              {/* Arrow */}
              <div className="text-center text-zinc-600">↓</div>

              {/* Transformer Blocks */}
              <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800">
                <div className="text-xs text-zinc-500 mb-2 text-center">{ma.thinkingLayerLabel.replaceAll('{count}', String(modelConfig.nLayer))}</div>

                {/* Attention */}
                <button
                  onClick={() => setSelectedLayer('attention')}
                  className={`w-full p-2 rounded-lg border mb-2 transition-all ${
                    selectedLayer === 'attention'
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs">{ma.attentionButtonLabel}</div>
                </button>

                {/* Residual */}
                <div className="text-center text-xs text-zinc-600 mb-2">{ma.residualLabel}</div>

                {/* FFN */}
                <button
                  onClick={() => setSelectedLayer('ffn')}
                  className={`w-full p-2 rounded-lg border transition-all ${
                    selectedLayer === 'ffn'
                      ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs">{ma.ffnButtonLabel}</div>
                </button>

                {/* Residual */}
                <div className="text-center text-xs text-zinc-600 mt-2">{ma.residualLabel}</div>
              </div>

              {/* Arrow */}
              <div className="text-center text-zinc-600">↓</div>

              {/* Output Layer */}
              <button
                onClick={() => setSelectedLayer('output')}
                className={`w-full p-3 rounded-lg border transition-all ${
                  selectedLayer === 'output'
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <div className="text-sm font-medium">{ma.outputButtonTitle}</div>
                <div className="text-xs text-zinc-500 mt-1">
                  {ma.outputButtonSub.replace('{count}', String(modelConfig.vocabSize))}
                </div>
              </button>

              {/* Output */}
              <div className="text-center text-xs text-zinc-500 mt-2">
                {ma.diagramOutput}
              </div>
            </div>

            <p className="text-xs text-zinc-600 mt-4 text-center">
              {ma.diagramHint}
            </p>
          </div>

          {/* 参数统计 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Box className="w-4 h-4 text-blue-400" />
              {ma.paramsTitle}
            </h3>
            <div className="text-3xl font-bold text-blue-400 mb-2">
              {ma.paramsValue.replace('{count}', (totalParams / 1e6).toFixed(0))}
            </div>
            <div className="text-sm text-zinc-400">
              {ma.paramsUnit}
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              {ma.paramsHint}
            </p>
          </div>
        </div>

        {/* 右侧：详情和代码 */}
        <div className="space-y-6">
          {/* 层详情 */}
          {selectedLayer && (
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700 animate-fadeIn">
              <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
                <Info className="w-4 h-4 text-emerald-400" />
                {layerDetails[selectedLayer].title}
              </h3>
              <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
                {layerDetails[selectedLayer].description}
              </p>
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-3">
                <div className="text-sm text-amber-300">
                  {layerDetails[selectedLayer].analogy}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-800">
                <div className="text-xs text-zinc-500 mb-1">{ma.simpleLabel}</div>
                <div className="text-sm text-emerald-400">
                  {layerDetails[selectedLayer].simple}
                </div>
              </div>
            </div>
          )}

          {/* 模型配置 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              {ma.configTitle}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: ma.configLabels.vocabSize, value: modelConfig.vocabSize, color: 'text-emerald-400' },
                { label: ma.configLabels.blockSize, value: modelConfig.blockSize, color: 'text-blue-400' },
                { label: ma.configLabels.nLayer, value: modelConfig.nLayer, color: 'text-purple-400' },
                { label: ma.configLabels.nHead, value: modelConfig.nHead, color: 'text-amber-400' },
              ].map((item) => (
                <div key={item.label} className="p-3 rounded-lg bg-zinc-800">
                  <div className={`text-xl font-bold ${item.color}`}>{item.value}</div>
                  <div className="text-xs text-zinc-500">{item.label}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-3">
              {ma.configHint}
            </p>
          </div>

          {/* 工作流程 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">🔄</span>
              {ma.workflowTitle}
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <span className="text-2xl">📝</span>
                <div>
                  <div className="text-sm text-emerald-300 font-medium">{ma.workflowStep1Label}</div>
                  <div className="text-xs text-zinc-400">{ma.workflowStep1Desc}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <span className="text-2xl">🔗</span>
                <div>
                  <div className="text-sm text-blue-300 font-medium">{ma.workflowStep2Label}</div>
                  <div className="text-xs text-zinc-400">{ma.workflowStep2Desc}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                <span className="text-2xl">🧠</span>
                <div>
                  <div className="text-sm text-purple-300 font-medium">{ma.workflowStep3Label}</div>
                  <div className="text-xs text-zinc-400">{ma.workflowStep3Desc}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <span className="text-2xl">🎯</span>
                <div>
                  <div className="text-sm text-amber-300 font-medium">{ma.workflowStep4Label}</div>
                  <div className="text-xs text-zinc-400">{ma.workflowStep4Desc}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="mt-8 p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {ma.termsTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {ma.terms.map((term) => (
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

      {/* 导航按钮 */}
      <div className="mt-8 flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-zinc-700 text-zinc-400 font-medium hover:bg-zinc-600 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          {ma.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
        >
          {ma.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
