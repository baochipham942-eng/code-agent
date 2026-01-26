// ============================================================================
// Finetuning - nanoGPT 微调阶段（后训练核心内容）
// 展示如何加载预训练权重并适应特定任务
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Wrench,
  Download,
  Play,
  Pause,
  RotateCcw,
  ArrowRight,
  Check,
  AlertCircle,
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
    quality: '基础',
    color: 'zinc',
  },
  gpt2: {
    startLoss: 3.8,
    finalLoss: 1.8,
    steps: 5000,
    quality: '优秀',
    color: 'emerald',
  },
};

// 生成样本
const sampleOutputs = {
  scratch: `ROMEO: I am not my lord, the king of France,
And therefore am I not a man of my soul.
I have no more to say, but I am a fool.`,
  gpt2: `ROMEO: But soft! What light through yonder window breaks?
It is the east, and Juliet is the sun.
Arise, fair sun, and kill the envious moon.`,
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
          <Wrench className="w-5 h-5 text-amber-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">微调（Fine-tuning）⭐ 后训练核心</h3>
            <p className="text-xs text-zinc-400">
              微调是将预训练模型适应到特定任务的关键步骤。通过加载 GPT-2 预训练权重，
              在 Shakespeare 数据上微调，可以快速获得高质量的文本生成能力。
            </p>
          </div>
        </div>
      </div>

      {/* Why Fine-tuning */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">为什么需要微调？</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* From Scratch */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-4 h-4 text-zinc-500" />
              <span className="text-sm font-medium text-zinc-400">从头训练</span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">初始 Loss</span>
                <span className="text-zinc-400">{comparisonData.scratch.startLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">最终 Loss</span>
                <span className="text-zinc-400">{comparisonData.scratch.finalLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">所需步数</span>
                <span className="text-zinc-400">{comparisonData.scratch.steps.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">生成质量</span>
                <span className="text-zinc-400">{comparisonData.scratch.quality}</span>
              </div>
            </div>
          </div>

          {/* Fine-tuning */}
          <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Check className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-emerald-400">GPT-2 微调</span>
              <span className="text-xs px-1.5 py-0.5 bg-emerald-500/20 rounded text-emerald-300">推荐</span>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">初始 Loss</span>
                <span className="text-emerald-400">{comparisonData.gpt2.startLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">最终 Loss</span>
                <span className="text-emerald-400">{comparisonData.gpt2.finalLoss}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">所需步数</span>
                <span className="text-emerald-400">{comparisonData.gpt2.steps.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">生成质量</span>
                <span className="text-emerald-400">{comparisonData.gpt2.quality}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Fine-tuning Process */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">微调流程</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-between">
            {/* Step 1: Download */}
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={downloadWeights}
                disabled={downloadedWeights}
                className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${
                  downloadedWeights
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : 'bg-blue-500/20 border-blue-500/50 text-blue-400 hover:bg-blue-500/30 cursor-pointer'
                }`}
              >
                {downloadedWeights ? <Check className="w-5 h-5" /> : <Download className="w-5 h-5" />}
              </button>
              <span className="text-xs text-zinc-500">下载 GPT-2 权重</span>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-600" />

            {/* Step 2: Load */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${
                  downloadedWeights
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
                }`}
              >
                {downloadedWeights ? <Check className="w-5 h-5" /> : '2'}
              </div>
              <span className="text-xs text-zinc-500">加载预训练权重</span>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-600" />

            {/* Step 3: Fine-tune */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${
                  currentStep > 0
                    ? currentStep >= config.maxIters
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                      : 'bg-amber-500/20 border-amber-500/50 text-amber-400 animate-pulse'
                    : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
                }`}
              >
                {currentStep >= config.maxIters ? <Check className="w-5 h-5" /> : <Wrench className="w-5 h-5" />}
              </div>
              <span className="text-xs text-zinc-500">在目标数据微调</span>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-600" />

            {/* Step 4: Inference */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${
                  currentStep >= config.maxIters
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
                }`}
              >
                {currentStep >= config.maxIters ? <Check className="w-5 h-5" /> : '4'}
              </div>
              <span className="text-xs text-zinc-500">推理生成</span>
            </div>
          </div>
        </div>
      </div>

      {/* Fine-tuning Config */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">微调配置</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Init From */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500">初始化来源</label>
            <div className="flex gap-2">
              {(['scratch', 'gpt2'] as InitFrom[]).map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    setConfig((c) => ({ ...c, initFrom: opt }));
                    resetTraining();
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm transition-all ${
                    config.initFrom === opt
                      ? opt === 'gpt2'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-zinc-700/50 text-zinc-300 border border-zinc-600/50'
                      : 'bg-zinc-800/30 text-zinc-500 border border-zinc-700/30 hover:border-zinc-600'
                  }`}
                >
                  {opt === 'scratch' ? '从头训练' : 'GPT-2 权重'}
                </button>
              ))}
            </div>
          </div>

          {/* Learning Rate */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500">
              学习率 <span className="text-amber-400">（微调用更小的 LR）</span>
            </label>
            <div className="px-3 py-2 bg-zinc-800/30 rounded-lg border border-zinc-700/30 text-sm text-zinc-300">
              {config.initFrom === 'gpt2' ? '3e-5' : '6e-4'}
            </div>
          </div>
        </div>
      </div>

      {/* Training Visualization */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">微调过程</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 border border-zinc-700/50"
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
                  开始微调
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <canvas ref={canvasRef} width={800} height={150} className="w-full h-36 rounded-lg" />

          <div className="mt-3 pt-3 border-t border-zinc-800/50 grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-zinc-500">当前 Loss</div>
              <div className="text-lg font-mono text-emerald-400">{latestLoss}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Step</div>
              <div className="text-lg font-mono text-zinc-300">
                {currentStep.toLocaleString()} / {config.maxIters.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Progress</div>
              <div className="text-lg font-mono text-blue-400">
                {((currentStep / config.maxIters) * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sample Output Comparison */}
      {currentStep >= config.maxIters && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-300">生成样本对比</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
              <div className="text-xs text-zinc-500 mb-2">从头训练</div>
              <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap">{sampleOutputs.scratch}</pre>
            </div>
            <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/30 p-4">
              <div className="text-xs text-emerald-400 mb-2">GPT-2 微调</div>
              <pre className="text-xs text-emerald-300 font-mono whitespace-pre-wrap">{sampleOutputs.gpt2}</pre>
            </div>
          </div>
        </div>
      )}

      {/* Key Takeaways */}
      <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
        <h4 className="text-sm font-medium text-amber-400 mb-2">微调要点</h4>
        <ul className="space-y-1 text-xs text-zinc-400">
          <li>• <strong className="text-zinc-300">更小的学习率</strong>：微调通常使用 1/10 ~ 1/100 的预训练学习率</li>
          <li>• <strong className="text-zinc-300">更少的步数</strong>：预训练权重已有良好初始化，微调收敛更快</li>
          <li>• <strong className="text-zinc-300">Early Stopping</strong>：监控验证 loss，防止过拟合</li>
          <li>• <strong className="text-zinc-300">保存检查点</strong>：定期保存模型，便于恢复最佳状态</li>
        </ul>
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
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all"
        >
          下一步：推理生成
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
