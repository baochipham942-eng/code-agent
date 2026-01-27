// ============================================================================
// Inference - nanoGPT 推理阶段
// 用通俗方式展示 AI 如何「说话」
// ============================================================================

import React, { useState, useCallback } from 'react';
import { ChevronLeft, MessageSquare, RefreshCw } from 'lucide-react';

interface InferenceProps {
  onBack: () => void;
}

interface SamplingConfig {
  temperature: number;
  topK: number;
  topP: number;
  maxTokens: number;
}

// 模拟的 token 概率分布（使用中文便于理解）
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

// 根据采样参数生成不同风格的文本
const generateText = (prompt: string, config: SamplingConfig): string => {
  const { temperature } = config;

  // 高温度 = 更随机、更有创意但可能混乱
  if (temperature > 1.2) {
    const randomOutputs = [
      `${prompt} 在星光闪烁的梦境深处，
月亮与蝴蝶跳着奇异的舞蹈，
时间化作流水，流向未知的彼岸......
（创意爆棚但有点跳跃！）`,
      `${prompt} 当彩虹学会了唱歌，
云朵变成了棉花糖的海洋，
所有的故事都开始倒着讲......
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
            <h3 className="text-sm font-medium text-zinc-200 mb-2">✍️ 让 AI 开口「说话」</h3>
            <p className="text-sm text-zinc-400">
              AI 学完后，就可以让它创作啦！我们可以调整它的「性格」——
              是更<span className="text-amber-400">「天马行空」</span>还是更
              <span className="text-blue-400">「稳重可靠」</span>？
            </p>
          </div>
        </div>
      </div>

      {/* Sampling Parameters - Simplified */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-300">🎛️ 调整 AI 的「性格」</h3>

        {/* Main Temperature Control */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🌡️</span>
              <div>
                <div className="text-sm font-medium text-zinc-200">创意程度</div>
                <div className="text-xs text-zinc-500">数值越高，AI 越有创意但可能会「跑题」</div>
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
            className="w-full h-3 bg-gradient-to-r from-blue-500/30 via-zinc-700 to-amber-500/30 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between mt-3">
            <div className="text-center">
              <div className="text-2xl">🤖</div>
              <div className="text-xs text-blue-400">稳重保守</div>
              <div className="text-xs text-zinc-600">内容可靠</div>
            </div>
            <div className="text-center">
              <div className="text-2xl">⚖️</div>
              <div className="text-xs text-emerald-400">平衡</div>
              <div className="text-xs text-zinc-600">推荐</div>
            </div>
            <div className="text-center">
              <div className="text-2xl">🎨</div>
              <div className="text-xs text-amber-400">天马行空</div>
              <div className="text-xs text-zinc-600">创意十足</div>
            </div>
          </div>
        </div>

        {/* Secondary Controls */}
        <div className="grid grid-cols-2 gap-4">
          {/* Top-k */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">📚</span>
              <span className="text-sm font-medium text-zinc-200">选词范围</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">从最可能的几个词里选（数字越小越保守）</p>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={config.topK}
              onChange={(e) => setConfig((c) => ({ ...c, topK: parseInt(e.target.value) }))}
              className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between mt-2 text-xs">
              <span className="text-zinc-500">只选1个</span>
              <span className="text-emerald-400 font-bold">{config.topK} 个</span>
              <span className="text-zinc-500">选100个</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">📝</span>
              <span className="text-sm font-medium text-zinc-200">写多少字</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">AI 最多写多少字后停下来</p>
            <input
              type="range"
              min="10"
              max="500"
              step="10"
              value={config.maxTokens}
              onChange={(e) => setConfig((c) => ({ ...c, maxTokens: parseInt(e.target.value) }))}
              className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between mt-2 text-xs">
              <span className="text-zinc-500">简短</span>
              <span className="text-blue-400 font-bold">{config.maxTokens} 字</span>
              <span className="text-zinc-500">详细</span>
            </div>
          </div>
        </div>
      </div>

      {/* Probability Distribution Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🤔 AI 在想：下一个字说什么？</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <p className="text-xs text-zinc-500 mb-4">
            AI 会给每个候选词打分，分数越高越可能被选中。当前创意程度：<span className="text-amber-400 font-bold">{config.temperature.toFixed(1)}</span>
          </p>

          <div className="space-y-2">
            {normalizedDistribution.slice(0, 6).map((item, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <span className="w-12 text-sm text-zinc-300">{item.token}</span>
                <div className="flex-1 h-6 bg-zinc-800/50 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      idx < 3 ? 'bg-emerald-500/60' : 'bg-zinc-600/40'
                    }`}
                    style={{ width: `${item.normalizedProb * 100 * 4}%` }}
                  />
                </div>
                <span className="w-16 text-sm text-zinc-400 text-right">
                  {(item.normalizedProb * 100).toFixed(0)}% 概率
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="text-xs text-amber-400">
              💡 创意程度低时，AI 会选最「安全」的词；创意程度高时，一些不常见的词也可能被选中！
            </div>
          </div>
        </div>
      </div>

      {/* Generation Interface */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🎯 试试让 AI 写点东西</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          {/* Prompt Input */}
          <div className="mb-4">
            <label className="text-xs text-zinc-500 mb-2 block">给 AI 一个开头：</label>
            <div className="flex gap-3">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="输入一个开头..."
                className="flex-1 px-4 py-3 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-zinc-200 focus:outline-none focus:border-blue-500/50"
              />
              <button
                onClick={handleGenerate}
                disabled={isGenerating}
                className={`flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-medium transition-all ${
                  isGenerating
                    ? 'bg-zinc-700/50 text-zinc-500 cursor-not-allowed'
                    : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
                }`}
              >
                <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
                {isGenerating ? '思考中...' : '✨ 开始写'}
              </button>
            </div>
          </div>

          {/* Output */}
          <div className="bg-zinc-950/50 rounded-lg p-4 min-h-[140px]">
            <div className="text-xs text-zinc-600 mb-2">AI 写的内容：</div>
            <div className="text-base text-zinc-300 whitespace-pre-wrap leading-relaxed">
              {output || <span className="text-zinc-600">点击「开始写」让 AI 创作...</span>}
              {isGenerating && <span className="animate-pulse text-emerald-400">|</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Simple Summary */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20">
        <h3 className="text-sm font-medium text-zinc-200 mb-3">📚 小结：AI 说话的「性格」</h3>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-xl">🤖</span>
            <div>
              <div className="text-blue-400 font-medium">创意程度低</div>
              <div className="text-xs text-zinc-500">说话稳重，内容可靠，不容易出错</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xl">⚖️</span>
            <div>
              <div className="text-emerald-400 font-medium">创意程度中</div>
              <div className="text-xs text-zinc-500">既有新意又通顺，推荐使用</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xl">🎨</span>
            <div>
              <div className="text-amber-400 font-medium">创意程度高</div>
              <div className="text-xs text-zinc-500">天马行空，但可能会跑题</div>
            </div>
          </div>
        </div>
      </div>

      {/* 恭喜完成 */}
      <div className="p-6 rounded-xl bg-gradient-to-r from-emerald-500/10 to-blue-500/10 border border-emerald-500/20 text-center">
        <div className="text-4xl mb-3">🎉</div>
        <h3 className="text-lg font-bold text-emerald-400 mb-2">恭喜你完成了 nanoGPT 学习之旅！</h3>
        <p className="text-sm text-zinc-400">
          你已经了解了 AI 是如何「读书」→「学习」→「进阶」→「创作」的全过程。
          <br />
          现在你对 AI 语言模型的工作原理有了更深入的理解！
        </p>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <div className="text-sm text-emerald-400 flex items-center gap-2 font-medium">
          ✅ 已完成全部学习
        </div>
      </div>
    </div>
  );
};
