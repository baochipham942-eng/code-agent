// ============================================================================
// Inference - nanoGPT 推理阶段
// 用通俗方式展示 AI 如何「说话」
// ============================================================================

import React, { useState, useCallback } from 'react';
import { ChevronLeft, MessageSquare, RefreshCw } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

interface InferenceProps {
  onBack: () => void;
}

interface SamplingConfig {
  temperature: number;
  topK: number;
  topP: number;
  maxTokens: number;
}

// 模拟的 token 概率分布 —— 候选下一词演示数据本身，不进 i18n（翻译会改变
// 这段"AI 在想下一个字"演示要展示的候选词分布效果）
const mockTokenDistribution = [
  { token: '美丽', prob: 0.15 },
  { token: '温柔', prob: 0.12 },
  { token: '可爱', prob: 0.10 },
  { token: '善良', prob: 0.08 },
  { token: '聪明', prob: 0.07 },
  { token: '勇敢', prob: 0.06 },
  { token: '神秘', prob: 0.05 },
  { token: '奇怪', prob: 0.04 },
  { token: '疯狂', prob: 0.03 },
  { token: '混乱', prob: 0.03 },
];

// 根据采样参数生成不同风格的文本 —— 生成结果本身是演示数据（含风格评语），
// 不进 i18n（翻译会改变"创意程度不同时中文写作质量对比"这个演示要展示的内容）
const generateText = (prompt: string, config: SamplingConfig): string => {
  const { temperature } = config;

  // 高温度 = 更随机、更有创意但可能混乱
  if (temperature > 1.2) {
    const randomOutputs = [
      `${prompt} 在星光闪烁的梦境深处，
月亮与蝴蝶跳着奇异的舞蹈，
时间化作流水，流向未知的彼岸……
（创意爆棚但有点跳跃！）`,
      `${prompt} 当彩虹学会了唱歌，
云朵变成了棉花糖的海洋，
所有的故事都开始倒着讲……
（天马行空，充满想象！）`,
    ];
    return randomOutputs[Math.floor(Math.random() * randomOutputs.length)];
  }

  // 低温度 = 更确定、更保守
  if (temperature < 0.5) {
    return `${prompt} 她是这个世界上最美丽的人。
每天早上，太阳升起，她就会醒来。
她喜欢在花园里散步，看着花儿开放。
（稳定可靠，但比较平淡）`;
  }

  // 中等温度 = 平衡
  const balancedOutputs = [
    `${prompt} 她站在窗边，望着远方的山峦。
晚风轻轻吹过她的发丝，
带来了春天的气息和未知的期待。
（既有意境又通顺！）`,
    `${prompt} 月光洒落在古老的石板路上，
她轻轻哼着那首熟悉的歌谣，
仿佛时光倒流，回到了那个夏天。
（优美流畅，情感丰富！）`,
  ];
  return balancedOutputs[Math.floor(Math.random() * balancedOutputs.length)];
};

export const Inference: React.FC<InferenceProps> = ({ onBack }) => {
  const { t } = useI18n();
  const inf = t.labNanogpt.inference;
  const [config, setConfig] = useState<SamplingConfig>({
    temperature: 0.8,
    topK: 40,
    topP: 0.9,
    maxTokens: 100,
  });
  const [prompt, setPrompt] = useState('她是一个');
  const [output, setOutput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  // 计算温度调整后的概率分布
  const adjustedDistribution = mockTokenDistribution.map((item) => {
    const adjustedProb = Math.pow(item.prob, 1 / config.temperature);
    return { ...item, adjustedProb };
  });
  const totalProb = adjustedDistribution.reduce((sum, item) => sum + item.adjustedProb, 0);
  const normalizedDistribution = adjustedDistribution.map((item) => ({
    ...item,
    normalizedProb: item.adjustedProb / totalProb,
  }));

  // 生成文本
  const handleGenerate = useCallback(() => {
    setIsGenerating(true);
    setOutput('');

    // 模拟逐字生成
    const fullText = generateText(prompt, config);
    let currentIndex = 0;

    const interval = setInterval(() => {
      if (currentIndex < fullText.length) {
        setOutput(fullText.slice(0, currentIndex + 1));
        currentIndex++;
      } else {
        clearInterval(interval);
        setIsGenerating(false);
      }
    }, 30);
  }, [prompt, config]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 rounded-lg border border-blue-500/20 p-4">
        <div className="flex items-start gap-3">
          <MessageSquare className="w-5 h-5 text-blue-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{inf.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {inf.introBodyPre}
              <span className="text-amber-400">{inf.introBodyHighlight1}</span>
              {inf.introBodyMid}
              <span className="text-blue-400">{inf.introBodyHighlight2}</span>
              {inf.introBodyPost}
            </p>
          </div>
        </div>
      </div>

      {/* Sampling Parameters - Simplified */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-400">{inf.sectionLabel}</h3>

        {/* Main Temperature Control */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🌡️</span>
              <div>
                <div className="text-sm font-medium text-zinc-200">{inf.tempLabel}</div>
                <div className="text-xs text-zinc-500">{inf.tempDesc}</div>
              </div>
            </div>
            <div className="text-2xl font-bold text-amber-400">{config.temperature.toFixed(1)}</div>
          </div>
          <input
            type="range"
            min="0.1"
            max="2.0"
            step="0.1"
            value={config.temperature}
            onChange={(e) => setConfig((c) => ({ ...c, temperature: parseFloat(e.target.value) }))}
            className="w-full h-3 bg-gradient-to-r from-blue-500/30 via-hover to-amber-500/30 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between mt-3">
            <div className="text-center">
              <div className="text-2xl">🤖</div>
              <div className="text-xs text-blue-400">{inf.tempConservative}</div>
              <div className="text-xs text-zinc-600">{inf.tempConservativeDesc}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl">⚖️</div>
              <div className="text-xs text-emerald-400">{inf.tempBalanced}</div>
              <div className="text-xs text-zinc-600">{inf.tempBalancedDesc}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl">🎨</div>
              <div className="text-xs text-amber-400">{inf.tempCreative}</div>
              <div className="text-xs text-zinc-600">{inf.tempCreativeDesc}</div>
            </div>
          </div>
        </div>

        {/* Secondary Controls */}
        <div className="grid grid-cols-2 gap-4">
          {/* Top-k */}
          <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">📚</span>
              <span className="text-sm font-medium text-zinc-200">{inf.topKLabel}</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">{inf.topKDesc}</p>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={config.topK}
              onChange={(e) => setConfig((c) => ({ ...c, topK: parseInt(e.target.value) }))}
              className="w-full h-2 bg-zinc-600 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between mt-2 text-xs">
              <span className="text-zinc-500">{inf.topKMin}</span>
              <span className="text-emerald-400 font-bold">{config.topK} {inf.topKUnit}</span>
              <span className="text-zinc-500">{inf.topKMax}</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">📝</span>
              <span className="text-sm font-medium text-zinc-200">{inf.maxTokensLabel}</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">{inf.maxTokensDesc}</p>
            <input
              type="range"
              min="10"
              max="500"
              step="10"
              value={config.maxTokens}
              onChange={(e) => setConfig((c) => ({ ...c, maxTokens: parseInt(e.target.value) }))}
              className="w-full h-2 bg-zinc-600 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between mt-2 text-xs">
              <span className="text-zinc-500">{inf.maxTokensMin}</span>
              <span className="text-blue-400 font-bold">{config.maxTokens} {inf.maxTokensUnit}</span>
              <span className="text-zinc-500">{inf.maxTokensMax}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Probability Distribution Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{inf.distributionLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <p className="text-xs text-zinc-500 mb-4">
            {inf.distributionHintPrefix}<span className="text-amber-400 font-bold">{config.temperature.toFixed(1)}</span>
          </p>

          <div className="space-y-2">
            {normalizedDistribution.slice(0, 6).map((item, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <span className="w-12 text-sm text-zinc-400">{item.token}</span>
                <div className="flex-1 h-6 bg-zinc-800 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      idx < 3 ? 'bg-emerald-500/60' : 'bg-zinc-600/40'
                    }`}
                    style={{ width: `${item.normalizedProb * 100 * 4}%` }}
                  />
                </div>
                <span className="w-16 text-sm text-zinc-400 text-right">
                  {(item.normalizedProb * 100).toFixed(0)}{inf.probSuffix}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="text-xs text-amber-400">
              {inf.distributionFooter}
            </div>
          </div>
        </div>
      </div>

      {/* Generation Interface */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{inf.generationLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          {/* Prompt Input */}
          <div className="mb-4">
            <label className="text-xs text-zinc-500 mb-2 block">{inf.promptInputLabel}</label>
            <div className="flex gap-3">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={inf.promptPlaceholder}
                className="flex-1 px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-hidden focus:border-blue-500/50"
              />
              <button
                onClick={handleGenerate}
                disabled={isGenerating}
                className={`flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-medium transition-all ${
                  isGenerating
                    ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                    : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
                }`}
              >
                <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
                {isGenerating ? inf.generatingLabel : inf.generateButton}
              </button>
            </div>
          </div>

          {/* Output */}
          <div className="bg-zinc-950/50 rounded-lg p-4 min-h-[140px]">
            <div className="text-xs text-zinc-600 mb-2">{inf.outputLabel}</div>
            <div className="text-base text-zinc-400 whitespace-pre-wrap leading-relaxed">
              {output || <span className="text-zinc-600">{inf.outputPlaceholder}</span>}
              {isGenerating && <span className="animate-pulse text-emerald-400">|</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Simple Summary */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20">
        <h3 className="text-sm font-medium text-zinc-200 mb-3">{inf.summaryLabel}</h3>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-xl">🤖</span>
            <div>
              <div className="text-blue-400 font-medium">{inf.summaryLowLabel}</div>
              <div className="text-xs text-zinc-500">{inf.summaryLowDesc}</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xl">⚖️</span>
            <div>
              <div className="text-emerald-400 font-medium">{inf.summaryMidLabel}</div>
              <div className="text-xs text-zinc-500">{inf.summaryMidDesc}</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xl">🎨</span>
            <div>
              <div className="text-amber-400 font-medium">{inf.summaryHighLabel}</div>
              <div className="text-xs text-zinc-500">{inf.summaryHighDesc}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 恭喜完成 */}
      <div className="p-6 rounded-xl bg-gradient-to-r from-emerald-500/10 to-blue-500/10 border border-emerald-500/20 text-center">
        <div className="text-4xl mb-3">🎉</div>
        <h3 className="text-lg font-bold text-emerald-400 mb-2">{inf.congratsTitle}</h3>
        <p className="text-sm text-zinc-400">
          {inf.congratsBodyLine1}
          <br />
          {inf.congratsBodyLine2}
        </p>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {inf.glossaryLabel}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {inf.glossary.map((term) => (
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
          {inf.backButton}
        </button>
        <div className="text-sm text-emerald-400 flex items-center gap-2 font-medium">
          {inf.completedLabel}
        </div>
      </div>
    </div>
  );
};
