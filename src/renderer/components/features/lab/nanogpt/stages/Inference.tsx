// ============================================================================
// Inference - nanoGPT 推理阶段
// 展示 Temperature、Top-k、Top-p 等采样策略
// ============================================================================

import React, { useState, useCallback } from 'react';
import { ChevronLeft, MessageSquare, Thermometer, Sliders, BarChart3, RefreshCw } from 'lucide-react';

interface InferenceProps {
  onBack: () => void;
}

interface SamplingConfig {
  temperature: number;
  topK: number;
  topP: number;
  maxTokens: number;
}

// 模拟的 token 概率分布
const mockTokenDistribution = [
  { token: 'the', prob: 0.15 },
  { token: 'a', prob: 0.12 },
  { token: 'fair', prob: 0.10 },
  { token: 'my', prob: 0.08 },
  { token: 'sweet', prob: 0.07 },
  { token: 'gentle', prob: 0.06 },
  { token: 'dear', prob: 0.05 },
  { token: 'good', prob: 0.04 },
  { token: 'great', prob: 0.03 },
  { token: 'true', prob: 0.03 },
];

// 根据采样参数生成不同风格的文本
const generateText = (prompt: string, config: SamplingConfig): string => {
  const { temperature, topK, topP } = config;

  // 高温度 = 更随机
  if (temperature > 1.2) {
    const randomOutputs = [
      `${prompt} dancing moon whispers through crystalline echoes of forgotten dreams,
where shadows weave tapestries of light and darkness intertwined...`,
      `${prompt} beneath the velvet sky, stars sing melodies unheard by mortal ears,
as time itself bends to witness the eternal dance of cosmic dust...`,
      `${prompt} fire and ice collide in the heart of the wandering soul,
seeking truth in riddles wrapped in morning mist and twilight's glow...`,
    ];
    return randomOutputs[Math.floor(Math.random() * randomOutputs.length)];
  }

  // 低温度 = 更确定
  if (temperature < 0.5) {
    return `${prompt} is the sun, and I am the moon. We are bound by the laws of nature,
destined to forever chase each other across the sky. This is our fate.`;
  }

  // 中等温度 = 平衡
  const balancedOutputs = [
    `${prompt} the fairest creature of the night, whose beauty outshines
the stars themselves. In her presence, even the moon grows envious.`,
    `${prompt} sweet Juliet, my heart's desire, whose gentle words
are like honey to my ears. For her, I would defy the very heavens.`,
    `${prompt} love's gentle servant, bound by passion's chains.
Through storm and calm, my devotion shall never wane.`,
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
  const [prompt, setPrompt] = useState('ROMEO:');
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
    }, 20);
  }, [prompt, config]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 rounded-lg border border-blue-500/20 p-4">
        <div className="flex items-start gap-3">
          <MessageSquare className="w-5 h-5 text-blue-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">推理与生成</h3>
            <p className="text-xs text-zinc-400">
              调整采样参数来控制生成文本的创造性和确定性。理解 Temperature、Top-k、Top-p 的作用。
            </p>
          </div>
        </div>
      </div>

      {/* Sampling Parameters */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Sliders className="w-4 h-4 text-zinc-400" />
          采样参数
        </h3>

        <div className="grid grid-cols-4 gap-4">
          {/* Temperature */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Thermometer className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-zinc-200">Temperature</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="2.0"
              step="0.1"
              value={config.temperature}
              onChange={(e) => setConfig((c) => ({ ...c, temperature: parseFloat(e.target.value) }))}
              className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between mt-2 text-xs">
              <span className="text-blue-400">确定</span>
              <span className="text-zinc-300 font-mono">{config.temperature.toFixed(1)}</span>
              <span className="text-amber-400">随机</span>
            </div>
          </div>

          {/* Top-k */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-zinc-200">Top-k</span>
            </div>
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
              <span className="text-zinc-500">1</span>
              <span className="text-zinc-300 font-mono">{config.topK}</span>
              <span className="text-zinc-500">100</span>
            </div>
          </div>

          {/* Top-p */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-zinc-200">Top-p (Nucleus)</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={config.topP}
              onChange={(e) => setConfig((c) => ({ ...c, topP: parseFloat(e.target.value) }))}
              className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between mt-2 text-xs">
              <span className="text-zinc-500">0.1</span>
              <span className="text-zinc-300 font-mono">{config.topP.toFixed(2)}</span>
              <span className="text-zinc-500">1.0</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-medium text-zinc-200">Max Tokens</span>
            </div>
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
              <span className="text-zinc-500">10</span>
              <span className="text-zinc-300 font-mono">{config.maxTokens}</span>
              <span className="text-zinc-500">500</span>
            </div>
          </div>
        </div>
      </div>

      {/* Probability Distribution Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Token 概率分布</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-zinc-500">下一个 token 预测（Temperature = {config.temperature.toFixed(1)}）</span>
          </div>

          <div className="space-y-2">
            {normalizedDistribution.slice(0, 8).map((item, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <span className="w-16 text-xs font-mono text-zinc-400">{item.token}</span>
                <div className="flex-1 h-5 bg-zinc-800/50 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      idx < config.topK && item.normalizedProb > (1 - config.topP)
                        ? 'bg-emerald-500/50'
                        : 'bg-zinc-700/50'
                    }`}
                    style={{ width: `${item.normalizedProb * 100 * 5}%` }}
                  />
                </div>
                <span className="w-16 text-xs font-mono text-zinc-500 text-right">
                  {(item.normalizedProb * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 pt-3 border-t border-zinc-800/50 flex items-center gap-4 text-xs text-zinc-500">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-emerald-500/50" />
              <span>Top-k 内 & Top-p 累积概率内</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-zinc-700/50" />
              <span>被过滤</span>
            </div>
          </div>
        </div>
      </div>

      {/* Generation Interface */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">生成测试</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          {/* Prompt Input */}
          <div className="flex gap-3 mb-4">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入 prompt..."
              className="flex-1 px-4 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-zinc-200 text-sm focus:outline-none focus:border-blue-500/50"
            />
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                isGenerating
                  ? 'bg-zinc-700/50 text-zinc-500 cursor-not-allowed'
                  : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
              }`}
            >
              <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
              {isGenerating ? '生成中...' : '生成'}
            </button>
          </div>

          {/* Output */}
          <div className="bg-zinc-950/50 rounded-lg p-4 min-h-[120px]">
            <pre className="text-sm text-zinc-300 font-mono whitespace-pre-wrap">
              {output || <span className="text-zinc-600">点击"生成"查看结果...</span>}
              {isGenerating && <span className="animate-pulse">|</span>}
            </pre>
          </div>
        </div>
      </div>

      {/* Sampling Strategy Explanation */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
          <h4 className="text-sm font-medium text-amber-400 mb-2">Temperature</h4>
          <p className="text-xs text-zinc-400">
            控制概率分布的"锐利度"。
            <br />• T {'<'} 1: 分布更集中，输出更确定
            <br />• T = 1: 原始分布
            <br />• T {'>'} 1: 分布更平坦，输出更随机
          </p>
        </div>

        <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
          <h4 className="text-sm font-medium text-emerald-400 mb-2">Top-k</h4>
          <p className="text-xs text-zinc-400">
            只从概率最高的 k 个 token 中采样。
            <br />• k 小: 更保守，避免低概率词
            <br />• k 大: 更多样，但可能出现奇怪词
          </p>
        </div>

        <div className="bg-purple-500/5 rounded-lg border border-purple-500/20 p-4">
          <h4 className="text-sm font-medium text-purple-400 mb-2">Top-p (Nucleus)</h4>
          <p className="text-xs text-zinc-400">
            动态选择累积概率达到 p 的 token 集合。
            <br />• p = 0.9: 选择占总概率 90% 的 token
            <br />• 比 Top-k 更动态，自适应词汇量
          </p>
        </div>
      </div>

      {/* nanoGPT Inference Command */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">nanoGPT 推理命令</h3>
        <div className="bg-zinc-950/50 rounded-lg border border-zinc-800/50 p-4 font-mono text-xs">
          <div className="text-zinc-500 mb-2"># 使用训练好的模型生成文本</div>
          <div className="text-emerald-400">
            python sample.py \<br />
            {'    '}--out_dir=out-shakespeare-char \<br />
            {'    '}--start="ROMEO:" \<br />
            {'    '}--num_samples=3 \<br />
            {'    '}--max_new_tokens=500 \<br />
            {'    '}--temperature={config.temperature.toFixed(1)} \<br />
            {'    '}--top_k={config.topK}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <div className="text-sm text-zinc-500 flex items-center gap-2">
          🎉 恭喜完成 nanoGPT 学习流程！
        </div>
      </div>
    </div>
  );
};
