// ============================================================================
// Pretraining - nanoGPT 预训练阶段
// 用通俗方式展示 AI「学习」的过程
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Play,
  Pause,
  RotateCcw,
  BookOpen,
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
          <BookOpen className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">📚 AI 开始「读书学习」了！</h3>
            <p className="text-sm text-zinc-400">
              就像学生需要反复读书、做练习才能掌握知识一样，AI 也需要
              <span className="text-purple-400">「读」大量的文字</span>，
              通过不断<span className="text-purple-400">「猜下一个字」</span>的练习来学会写作。
            </p>
          </div>
        </div>
      </div>

      {/* Training Config */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">📋 学习计划设置</h3>
        <div className="grid grid-cols-5 gap-3">
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">📖 每次读几段</div>
            <div className="text-sm font-medium text-emerald-400">{config.batchSize} 段</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">✏️ 改正的力度</div>
            <div className="text-sm font-medium text-emerald-400">适中</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">🔄 练习多少轮</div>
            <div className="text-sm font-medium text-emerald-400">{(config.maxIters / 1000).toFixed(0)}K 轮</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">🧠 记忆积累</div>
            <div className="text-sm font-medium text-emerald-400">{config.gradAccumSteps} 次</div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
            <div className="text-xs text-zinc-500 mb-1">🌡️ 热身阶段</div>
            <div className="text-sm font-medium text-emerald-400">{config.warmupIters} 步</div>
          </div>
        </div>
      </div>

      {/* Training Visualization */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">📈 看 AI 学习进步（点击体验）</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 border border-zinc-700/50 transition-all"
              title="重新开始"
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
                  暂停学习
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

        {/* Loss Chart */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-1 bg-emerald-500 rounded" />
                <span className="text-xs text-zinc-400">练习时的错误率</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-1 bg-amber-500 rounded" />
                <span className="text-xs text-zinc-400">考试时的错误率</span>
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              已学习 <span className="text-emerald-400 font-bold">{currentStep.toLocaleString()}</span> / 100,000 轮
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
            <div className="text-center p-2 bg-emerald-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">📝 练习错误率</div>
              <div className="text-xl font-bold text-emerald-400">{latestLoss}</div>
              <div className="text-xs text-zinc-600">越低越好</div>
            </div>
            <div className="text-center p-2 bg-amber-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">📋 考试错误率</div>
              <div className="text-xl font-bold text-amber-400">{latestValLoss}</div>
              <div className="text-xs text-zinc-600">越低越好</div>
            </div>
            <div className="text-center p-2 bg-blue-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">✏️ 改正力度</div>
              <div className="text-xl font-bold text-blue-400">
                {currentLr > 0 ? '适中' : '未开始'}
              </div>
              <div className="text-xs text-zinc-600">会逐渐减小</div>
            </div>
            <div className="text-center p-2 bg-purple-500/10 rounded-lg">
              <div className="text-xs text-zinc-500 mb-1">📊 学习进度</div>
              <div className="text-xl font-bold text-purple-400">{((currentStep / 100000) * 100).toFixed(1)}%</div>
              <div className="text-xs text-zinc-600">加油！</div>
            </div>
          </div>
        </div>
      </div>

      {/* Training Techniques */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🎯 学习的小技巧</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* 学习过程 */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">📚</span>
              <span className="text-sm font-medium text-zinc-200">边读边记</span>
            </div>
            <p className="text-sm text-zinc-400">
              AI 一次读 {config.batchSize} 段文字，读完 {config.gradAccumSteps} 次后再「总结记忆」，
              这样能学得更扎实。
            </p>
          </div>

          {/* 改正力度 */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">✏️</span>
              <span className="text-sm font-medium text-zinc-200">逐步放缓</span>
            </div>
            <p className="text-sm text-zinc-400">
              刚开始学习时改正力度大，后来慢慢减小。
              就像学骑车，一开始大幅调整，熟练后只需微调。
            </p>
          </div>

          {/* 热身 */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🌡️</span>
              <span className="text-sm font-medium text-zinc-200">先热身</span>
            </div>
            <p className="text-sm text-zinc-400">
              开始时先慢慢「预热」，不急着全力学习。
              就像运动前要热身一样，能防止「学歪」。
            </p>
          </div>

          {/* 持续进步 */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">📉</span>
              <span className="text-sm font-medium text-zinc-200">错误越来越少</span>
            </div>
            <p className="text-sm text-zinc-400">
              观察上面的曲线：随着学习进行，错误率会不断下降。
              当曲线变平时，说明学得差不多了！
            </p>
          </div>
        </div>
      </div>

      {/* 学习总结 */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-500/10 to-blue-500/10 border border-emerald-500/20">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">💡 学习的关键是什么？</h3>
        <p className="text-sm text-zinc-400">
          AI 通过「猜下一个字」来学习。看到「今天天气真」，它要猜下一个是「好」。
          猜对了就继续，猜错了就调整自己。重复几十万次后，它就学会了写作的规律！
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
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 border border-amber-500/30 transition-all font-medium"
        >
          下一步：进阶学习
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
