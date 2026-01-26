// ============================================================================
// Pretraining - nanoGPT 预训练阶段
// 展示大规模预训练过程和训练技巧
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Play,
  Pause,
  RotateCcw,
  Cpu,
  Zap,
  TrendingDown,
  Settings,
} from 'lucide-react';

interface PretrainingProps {
  onComplete: () => void;
  onBack: () => void;
}

interface TrainingConfig {
  batchSize: number;
  learningRate: number;
  maxIters: number;
  gradAccumSteps: number;
  warmupIters: number;
}

const defaultConfig: TrainingConfig = {
  batchSize: 12,
  learningRate: 6e-4,
  maxIters: 600000,
  gradAccumSteps: 5,
  warmupIters: 2000,
};

// 模拟的训练数据点
const generateTrainingData = (step: number): { loss: number; valLoss: number; lr: number } => {
  // 模拟 loss 下降曲线
  const baseLoss = 4.5 * Math.exp(-step / 50000) + 2.8;
  const noise = Math.random() * 0.1;
  const loss = baseLoss + noise;

  // 验证 loss 略高于训练 loss
  const valLoss = loss + 0.1 + Math.random() * 0.05;

  // 学习率 warmup + cosine decay
  let lr = defaultConfig.learningRate;
  if (step < defaultConfig.warmupIters) {
    lr = (step / defaultConfig.warmupIters) * defaultConfig.learningRate;
  } else {
    const decay = 0.5 * (1 + Math.cos(Math.PI * (step - defaultConfig.warmupIters) / (defaultConfig.maxIters - defaultConfig.warmupIters)));
    lr = defaultConfig.learningRate * decay;
  }

  return { loss, valLoss, lr };
};

export const Pretraining: React.FC<PretrainingProps> = ({ onComplete, onBack }) => {
  const [config, setConfig] = useState<TrainingConfig>(defaultConfig);
  const [isTraining, setIsTraining] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [lossHistory, setLossHistory] = useState<{ step: number; loss: number; valLoss: number }[]>([]);
  const [currentLr, setCurrentLr] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 开始/暂停训练
  const toggleTraining = () => {
    if (isTraining) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      setIsTraining(false);
    } else {
      setIsTraining(true);
      intervalRef.current = setInterval(() => {
        setCurrentStep((prev) => {
          const newStep = prev + 1000;
          const data = generateTrainingData(newStep);
          setCurrentLr(data.lr);
          setLossHistory((h) => [...h.slice(-100), { step: newStep, loss: data.loss, valLoss: data.valLoss }]);

          if (newStep >= 100000) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
            }
            setIsTraining(false);
            return 100000;
          }
          return newStep;
        });
      }, 100);
    }
  };

  // 重置
  const resetTraining = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    setIsTraining(false);
    setCurrentStep(0);
    setLossHistory([]);
    setCurrentLr(0);
  };

  // 清理
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
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

    // 清空
    ctx.fillStyle = 'rgba(24, 24, 27, 0.5)';
    ctx.fillRect(0, 0, width, height);

    // 绘制网格
    ctx.strokeStyle = 'rgba(63, 63, 70, 0.3)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const y = (height / 5) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // 计算范围
    const losses = lossHistory.map((d) => d.loss);
    const valLosses = lossHistory.map((d) => d.valLoss);
    const maxLoss = Math.max(...losses, ...valLosses);
    const minLoss = Math.min(...losses, ...valLosses);
    const range = maxLoss - minLoss || 1;

    // 绘制训练 loss
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    lossHistory.forEach((d, i) => {
      const x = (i / (lossHistory.length - 1)) * width;
      const y = height - ((d.loss - minLoss) / range) * height * 0.8 - height * 0.1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 绘制验证 loss
    ctx.strokeStyle = '#f59e0b';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    lossHistory.forEach((d, i) => {
      const x = (i / (lossHistory.length - 1)) * width;
      const y = height - ((d.valLoss - minLoss) / range) * height * 0.8 - height * 0.1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }, [lossHistory]);

  const latestLoss = lossHistory[lossHistory.length - 1]?.loss.toFixed(4) || '-.----';
  const latestValLoss = lossHistory[lossHistory.length - 1]?.valLoss.toFixed(4) || '-.----';

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-lg border border-purple-500/20 p-4">
        <div className="flex items-start gap-3">
          <Cpu className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">预训练阶段</h3>
            <p className="text-xs text-zinc-400">
              预训练是在大规模无标注文本上训练模型，让模型学习语言的统计规律。
              nanoGPT 支持从头训练或加载 GPT-2 预训练权重。
            </p>
          </div>
        </div>
      </div>

      {/* Training Config */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Settings className="w-4 h-4 text-zinc-400" />
          训练配置
        </h3>
        <div className="grid grid-cols-5 gap-3">
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">Batch Size</div>
            <div className="text-sm font-medium text-zinc-200">{config.batchSize}</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">Learning Rate</div>
            <div className="text-sm font-medium text-zinc-200">{config.learningRate.toExponential(0)}</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">Max Iters</div>
            <div className="text-sm font-medium text-zinc-200">{(config.maxIters / 1000).toFixed(0)}K</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">Grad Accum</div>
            <div className="text-sm font-medium text-zinc-200">{config.gradAccumSteps}</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">Warmup</div>
            <div className="text-sm font-medium text-zinc-200">{config.warmupIters}</div>
          </div>
        </div>
      </div>

      {/* Training Visualization */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">训练过程模拟</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 border border-zinc-700/50 transition-all"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleTraining}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                isTraining
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
                  开始模拟
                </>
              )}
            </button>
          </div>
        </div>

        {/* Loss Chart */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-0.5 bg-emerald-500 rounded" />
                <span className="text-xs text-zinc-500">Train Loss</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-0.5 bg-amber-500 rounded border-dashed" />
                <span className="text-xs text-zinc-500">Val Loss</span>
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              Step: <span className="text-zinc-300">{currentStep.toLocaleString()}</span> / 100,000
            </div>
          </div>

          <canvas
            ref={canvasRef}
            width={800}
            height={200}
            className="w-full h-48 rounded-lg"
          />

          {/* Metrics */}
          <div className="mt-4 pt-3 border-t border-zinc-800/50 grid grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-zinc-500">Train Loss</div>
              <div className="text-lg font-mono text-emerald-400">{latestLoss}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Val Loss</div>
              <div className="text-lg font-mono text-amber-400">{latestValLoss}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Learning Rate</div>
              <div className="text-lg font-mono text-blue-400">{currentLr.toExponential(2)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Progress</div>
              <div className="text-lg font-mono text-zinc-300">{((currentStep / 100000) * 100).toFixed(1)}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Training Techniques */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">训练技巧</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Gradient Accumulation */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-zinc-200">梯度累积</span>
            </div>
            <p className="text-xs text-zinc-500 mb-2">
              在显存有限时，通过多次前向传播累积梯度，模拟更大的 batch size
            </p>
            <div className="bg-zinc-950/50 p-2 rounded text-xs font-mono text-zinc-400">
              effective_batch = batch_size × grad_accum_steps
              <br />
              = {config.batchSize} × {config.gradAccumSteps} = {config.batchSize * config.gradAccumSteps}
            </div>
          </div>

          {/* Mixed Precision */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="w-4 h-4 text-blue-400" />
              <span className="text-sm font-medium text-zinc-200">混合精度训练 (AMP)</span>
            </div>
            <p className="text-xs text-zinc-500 mb-2">
              使用 FP16/BF16 计算加速训练，同时保持 FP32 精度的参数更新
            </p>
            <div className="bg-zinc-950/50 p-2 rounded text-xs font-mono text-zinc-400">
              scaler = torch.cuda.amp.GradScaler()
              <br />
              with torch.cuda.amp.autocast():
            </div>
          </div>

          {/* Learning Rate Schedule */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-zinc-200">学习率调度</span>
            </div>
            <p className="text-xs text-zinc-500 mb-2">
              Warmup + Cosine Decay: 先线性增加到峰值，再余弦衰减到最小值
            </p>
            <div className="bg-zinc-950/50 p-2 rounded text-xs font-mono text-zinc-400">
              warmup: 0 → {config.learningRate.toExponential(0)} ({config.warmupIters} steps)
              <br />
              decay: {config.learningRate.toExponential(0)} → {(config.learningRate * 0.1).toExponential(0)} (cosine)
            </div>
          </div>

          {/* torch.compile */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-zinc-200">torch.compile()</span>
            </div>
            <p className="text-xs text-zinc-500 mb-2">
              PyTorch 2.0+ 的编译优化，可显著加速训练（~2x on A100）
            </p>
            <div className="bg-zinc-950/50 p-2 rounded text-xs font-mono text-zinc-400">
              model = torch.compile(model)
              <br />
              <span className="text-zinc-600"># 需要 PyTorch 2.0+</span>
            </div>
          </div>
        </div>
      </div>

      {/* nanoGPT Command */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">nanoGPT 训练命令</h3>
        <div className="bg-zinc-950/50 rounded-lg border border-zinc-800/50 p-4 font-mono text-xs">
          <div className="text-zinc-500 mb-2"># 从头训练 Shakespeare 数据集</div>
          <div className="text-emerald-400">
            python train.py config/train_shakespeare_char.py
          </div>
          <div className="text-zinc-500 mt-3 mb-2"># 使用 GPT-2 权重在 Shakespeare 上微调</div>
          <div className="text-blue-400">
            python train.py config/finetune_shakespeare.py \<br />
            {'    '}--init_from=gpt2
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
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 border border-amber-500/30 transition-all"
        >
          下一步：微调（后训练）
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
