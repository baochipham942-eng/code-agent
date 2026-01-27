// ============================================================================
// Finetuning - nanoGPT 微调阶段（进阶学习）
// 用通俗方式展示「站在巨人肩膀上」的学习方法
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Download,
  Play,
  Pause,
  RotateCcw,
  ArrowRight,
  Check,
  BookOpen,
} from 'lucide-react';

interface FinetuningProps {
  onComplete: () => void;
  onBack: () => void;
}

type InitFrom = 'scratch' | 'gpt2' | 'gpt2-medium' | 'resume';

interface FinetuneConfig {
  initFrom: InitFrom;
  learningRate: number;
  maxIters: number;
  evalInterval: number;
  warmupIters: number;
}

const defaultConfig: FinetuneConfig = {
  initFrom: 'gpt2',
  learningRate: 3e-5, // 微调用更小的学习率
  maxIters: 5000,
  evalInterval: 250,
  warmupIters: 100,
};

// 对比数据
const comparisonData = {
  scratch: {
    startLoss: 10.5,
    finalLoss: 3.2,
    steps: 50000,
    quality: '还行',
    analogy: '像从零开始学英语',
  },
  gpt2: {
    startLoss: 3.8,
    finalLoss: 1.8,
    steps: 5000,
    quality: '很棒',
    analogy: '像英语高手学莎士比亚',
  },
};

// 生成样本（翻译成中文便于理解）
const sampleOutputs = {
  scratch: `罗密欧：我不是我的主人，不是法国国王，
因此我也不是我灵魂的人。
我没有更多的话要说，但我是个傻瓜。
（语法有点乱，意思不太通顺）`,
  gpt2: `罗密欧：且慢！那边窗户透出什么光芒？
那是东方，而朱丽叶就是太阳。
升起吧，美丽的太阳，驱散那嫉妒的月亮。
（经典名句，优美流畅！）`,
};

export const Finetuning: React.FC<FinetuningProps> = ({ onComplete, onBack }) => {
  const [config, setConfig] = useState<FinetuneConfig>(defaultConfig);
  const [isTraining, setIsTraining] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [lossHistory, setLossHistory] = useState<{ step: number; loss: number }[]>([]);
  const [downloadedWeights, setDownloadedWeights] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 模拟下载权重
  const downloadWeights = () => {
    setDownloadedWeights(true);
  };

  // 生成训练数据
  const generateLoss = (step: number): number => {
    if (config.initFrom === 'scratch') {
      return 10.5 * Math.exp(-step / 15000) + 3.2 + Math.random() * 0.2;
    } else {
      return 3.8 * Math.exp(-step / 1500) + 1.8 + Math.random() * 0.1;
    }
  };

  // 开始/暂停训练
  const toggleTraining = () => {
    if (isTraining) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsTraining(false);
    } else {
      setIsTraining(true);
      intervalRef.current = setInterval(() => {
        setCurrentStep((prev) => {
          const newStep = prev + 100;
          const loss = generateLoss(newStep);
          setLossHistory((h) => [...h.slice(-50), { step: newStep, loss }]);

          if (newStep >= config.maxIters) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setIsTraining(false);
            return config.maxIters;
          }
          return newStep;
        });
      }, 80);
    }
  };

  // 重置
  const resetTraining = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsTraining(false);
    setCurrentStep(0);
    setLossHistory([]);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // 绘制 loss 曲线
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || lossHistory.length < 2) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = 'rgba(24, 24, 27, 0.5)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(63, 63, 70, 0.3)';
    for (let i = 0; i < 5; i++) {
      const y = (height / 5) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const losses = lossHistory.map((d) => d.loss);
    const maxLoss = Math.max(...losses) + 0.5;
    const minLoss = Math.min(...losses) - 0.5;
    const range = maxLoss - minLoss || 1;

    ctx.strokeStyle = config.initFrom === 'scratch' ? '#71717a' : '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    lossHistory.forEach((d, i) => {
      const x = (i / (lossHistory.length - 1)) * width;
      const y = height - ((d.loss - minLoss) / range) * height * 0.8 - height * 0.1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [lossHistory, config.initFrom]);

  const latestLoss = lossHistory[lossHistory.length - 1]?.loss.toFixed(4) || '-.----';

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-lg border border-amber-500/20 p-4">
        <div className="flex items-start gap-3">
          <BookOpen className="w-5 h-5 text-amber-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🚀 「站在巨人肩膀上」的学习方法</h3>
            <p className="text-sm text-zinc-400">
              与其从零开始学，不如先「借用」别人已经学好的知识！
              这就像一个英语高手来学莎士比亚戏剧——他已经会英语了，只需要学习莎士比亚的风格就行。
            </p>
          </div>
        </div>
      </div>

      {/* Why Fine-tuning */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🤔 两种学习方式，差别有多大？</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* From Scratch */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">🐣</span>
              <span className="text-sm font-medium text-zinc-400">方式一：从零开始学</span>
            </div>
            <p className="text-xs text-zinc-500 mb-3">{comparisonData.scratch.analogy}</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">📉 起始错误率</span>
                <span className="text-red-400 font-bold">{comparisonData.scratch.startLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">📈 最终错误率</span>
                <span className="text-amber-400">{comparisonData.scratch.finalLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">🔄 需要练习</span>
                <span className="text-zinc-400">{comparisonData.scratch.steps.toLocaleString()} 轮</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">⭐ 最终效果</span>
                <span className="text-zinc-400">{comparisonData.scratch.quality}</span>
              </div>
            </div>
          </div>

          {/* Fine-tuning */}
          <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">🎓</span>
              <span className="text-sm font-medium text-emerald-400">方式二：借用前人知识</span>
              <span className="text-xs px-1.5 py-0.5 bg-emerald-500/20 rounded text-emerald-300">推荐</span>
            </div>
            <p className="text-xs text-emerald-400/70 mb-3">{comparisonData.gpt2.analogy}</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">📉 起始错误率</span>
                <span className="text-emerald-400 font-bold">{comparisonData.gpt2.startLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">📈 最终错误率</span>
                <span className="text-emerald-400 font-bold">{comparisonData.gpt2.finalLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">🔄 需要练习</span>
                <span className="text-emerald-400">{comparisonData.gpt2.steps.toLocaleString()} 轮</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">⭐ 最终效果</span>
                <span className="text-emerald-400 font-bold">{comparisonData.gpt2.quality}</span>
              </div>
            </div>
          </div>
        </div>
        <p className="text-xs text-center text-amber-400">
          💡 借用知识后，只需 1/10 的练习量，就能达到更好的效果！
        </p>
      </div>

      {/* Fine-tuning Process */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">📝 进阶学习的步骤</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-between">
            {/* Step 1: Download */}
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={downloadWeights}
                disabled={downloadedWeights}
                className={`w-14 h-14 rounded-full flex items-center justify-center border transition-all ${
                  downloadedWeights
                    ? 'bg-emerald-500/20 border-emerald-500/50'
                    : 'bg-blue-500/20 border-blue-500/50 hover:bg-blue-500/30 cursor-pointer'
                }`}
              >
                {downloadedWeights ? <Check className="w-6 h-6 text-emerald-400" /> : <span className="text-2xl">📥</span>}
              </button>
              <span className="text-xs text-zinc-500 text-center">下载「高手的知识」</span>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-600" />

            {/* Step 2: Load */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center border transition-all ${
                  downloadedWeights
                    ? 'bg-emerald-500/20 border-emerald-500/50'
                    : 'bg-zinc-800/50 border-zinc-700/50'
                }`}
              >
                {downloadedWeights ? <Check className="w-6 h-6 text-emerald-400" /> : <span className="text-xl">🧠</span>}
              </div>
              <span className="text-xs text-zinc-500 text-center">装进 AI 大脑</span>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-600" />

            {/* Step 3: Fine-tune */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center border transition-all ${
                  currentStep > 0
                    ? currentStep >= config.maxIters
                      ? 'bg-emerald-500/20 border-emerald-500/50'
                      : 'bg-amber-500/20 border-amber-500/50 animate-pulse'
                    : 'bg-zinc-800/50 border-zinc-700/50'
                }`}
              >
                {currentStep >= config.maxIters ? <Check className="w-6 h-6 text-emerald-400" /> : <span className="text-xl">📚</span>}
              </div>
              <span className="text-xs text-zinc-500 text-center">学习新风格</span>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-600" />

            {/* Step 4: Inference */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center border transition-all ${
                  currentStep >= config.maxIters
                    ? 'bg-emerald-500/20 border-emerald-500/50'
                    : 'bg-zinc-800/50 border-zinc-700/50'
                }`}
              >
                {currentStep >= config.maxIters ? <Check className="w-6 h-6 text-emerald-400" /> : <span className="text-xl">✍️</span>}
              </div>
              <span className="text-xs text-zinc-500 text-center">开始创作</span>
            </div>
          </div>
        </div>
      </div>

      {/* Fine-tuning Config */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">⚙️ 选择学习方式</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Init From */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500">从哪里开始学？</label>
            <div className="flex gap-2">
              {(['scratch', 'gpt2'] as InitFrom[]).map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    setConfig((c) => ({ ...c, initFrom: opt }));
                    resetTraining();
                  }}
                  className={`flex-1 px-3 py-2.5 rounded-lg text-sm transition-all ${
                    config.initFrom === opt
                      ? opt === 'gpt2'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-zinc-700/50 text-zinc-300 border border-zinc-600/50'
                      : 'bg-zinc-800/30 text-zinc-500 border border-zinc-700/30 hover:border-zinc-600'
                  }`}
                >
                  {opt === 'scratch' ? '🐣 从零开始' : '🎓 借用高手知识'}
                </button>
              ))}
            </div>
          </div>

          {/* Learning Rate */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500">改正力度</label>
            <div className="px-3 py-2.5 bg-zinc-800/30 rounded-lg border border-zinc-700/30 text-sm">
              {config.initFrom === 'gpt2'
                ? <span className="text-emerald-400">轻轻调整 <span className="text-xs text-zinc-500">（已有好基础）</span></span>
                : <span className="text-amber-400">大幅调整 <span className="text-xs text-zinc-500">（什么都不会）</span></span>}
            </div>
          </div>
        </div>
      </div>

      {/* Training Visualization */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">📈 观察学习效果</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 border border-zinc-700/50"
              title="重新开始"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleTraining}
              disabled={!downloadedWeights && config.initFrom === 'gpt2'}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                !downloadedWeights && config.initFrom === 'gpt2'
                  ? 'bg-zinc-700/50 text-zinc-500 cursor-not-allowed'
                  : isTraining
                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              }`}
            >
              {isTraining ? (
                <>
                  <Pause className="w-4 h-4" />
                  暂停
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  ▶️ 开始学习
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <canvas ref={canvasRef} width={800} height={150} className="w-full h-36 rounded-lg" />

          <div className="mt-3 pt-3 border-t border-zinc-800/50 grid grid-cols-3 gap-4">
            <div className="text-center p-2 bg-emerald-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">📉 错误率</div>
              <div className="text-xl font-bold text-emerald-400">{latestLoss}</div>
            </div>
            <div className="text-center p-2 bg-blue-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">🔄 学习轮次</div>
              <div className="text-lg font-bold text-blue-400">
                {currentStep.toLocaleString()} / {config.maxIters.toLocaleString()}
              </div>
            </div>
            <div className="text-center p-2 bg-purple-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">📊 进度</div>
              <div className="text-xl font-bold text-purple-400">
                {((currentStep / config.maxIters) * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sample Output Comparison */}
      {currentStep >= config.maxIters && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-300">✨ 看看 AI 学完后写的东西</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🐣</span>
                <span className="text-xs text-zinc-500">从零开始学的 AI</span>
              </div>
              <pre className="text-sm text-zinc-400 whitespace-pre-wrap">{sampleOutputs.scratch}</pre>
            </div>
            <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🎓</span>
                <span className="text-xs text-emerald-400">借用知识的 AI</span>
              </div>
              <pre className="text-sm text-emerald-300 whitespace-pre-wrap">{sampleOutputs.gpt2}</pre>
            </div>
          </div>
        </div>
      )}

      {/* Key Takeaways */}
      <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
        <h4 className="text-sm font-medium text-amber-400 mb-3">💡 进阶学习的秘诀</h4>
        <div className="grid grid-cols-2 gap-3 text-sm text-zinc-400">
          <div className="flex items-start gap-2">
            <span>🐢</span>
            <span><strong className="text-zinc-300">慢慢调整</strong>：已经学过的知识，改正时要轻柔</span>
          </div>
          <div className="flex items-start gap-2">
            <span>⚡</span>
            <span><strong className="text-zinc-300">学得更快</strong>：有基础后，只需少量练习就能学会</span>
          </div>
          <div className="flex items-start gap-2">
            <span>👀</span>
            <span><strong className="text-zinc-300">及时检查</strong>：边学边考试，避免学过头</span>
          </div>
          <div className="flex items-start gap-2">
            <span>💾</span>
            <span><strong className="text-zinc-300">保存进度</strong>：定期保存，方便回退</span>
          </div>
        </div>
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
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all font-medium"
        >
          下一步：让 AI 开口说话
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
