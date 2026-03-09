// ============================================================================
// TrainingLoop - 阶段 4: 训练循环
// 展示训练过程，模拟 Loss 曲线变化
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronLeft, Play, Pause, Square, RotateCcw, TrendingDown } from 'lucide-react';

// 训练配置
interface TrainingConfig {
  batchSize: number;
  learningRate: number;
  epochs: number;
}

// 训练日志
interface TrainingLog {
  epoch: number;
  step: number;
  loss: number;
  timestamp: number;
}

// 模拟训练的 Loss 下降曲线
const generateLossCurve = (epochs: number): number[] => {
  const losses: number[] = [];
  let loss = 5.85; // 初始 loss
  const stepsPerEpoch = 100;

  for (let e = 0; e < epochs; e++) {
    for (let s = 0; s < stepsPerEpoch; s++) {
      // 模拟 loss 下降，加入随机波动
      const progress = (e * stepsPerEpoch + s) / (epochs * stepsPerEpoch);
      const targetLoss = 5.85 * Math.exp(-4 * progress) + 0.018;
      loss = targetLoss + (Math.random() - 0.5) * 0.1 * (1 - progress);
      losses.push(Math.max(0.01, loss));
    }
  }

  return losses;
};

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

export const TrainingLoop: React.FC<Props> = ({ onComplete, onBack }) => {
  const [config, setConfig] = useState<TrainingConfig>({
    batchSize: 32,
    learningRate: 3e-4,
    epochs: 20,
  });

  const [isTraining, setIsTraining] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [logs, setLogs] = useState<TrainingLog[]>([]);
  const [lossHistory, setLossHistory] = useState<number[]>([]);

  const lossCurveRef = useRef<number[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const totalSteps = config.epochs * 100;
  const currentEpoch = Math.floor(currentStep / 100) + 1;
  const stepInEpoch = (currentStep % 100) + 1;
  const currentLoss = lossHistory[currentStep] || 5.85;
  const progress = (currentStep / totalSteps) * 100;

  // 初始化 loss 曲线
  useEffect(() => {
    lossCurveRef.current = generateLossCurve(config.epochs);
  }, [config.epochs]);

  // 训练循环
  useEffect(() => {
    if (isTraining && !isPaused && currentStep < totalSteps) {
      intervalRef.current = setInterval(() => {
        setCurrentStep((prev) => {
          const next = prev + 1;
          if (next >= totalSteps) {
            setIsTraining(false);
            return prev;
          }

          // 更新 loss 历史
          setLossHistory((h) => [...h, lossCurveRef.current[next]]);

          // 每 20 步添加日志
          if (next % 20 === 0) {
            setLogs((l) => [
              {
                epoch: Math.floor(next / 100) + 1,
                step: (next % 100) + 1,
                loss: lossCurveRef.current[next],
                timestamp: Date.now(),
              },
              ...l.slice(0, 9),
            ]);
          }

          return next;
        });
      }, 50); // 每 50ms 更新一步
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isTraining, isPaused, currentStep, totalSteps]);

  // 开始训练
  const startTraining = () => {
    if (currentStep === 0) {
      lossCurveRef.current = generateLossCurve(config.epochs);
      setLossHistory([lossCurveRef.current[0]]);
    }
    setIsTraining(true);
    setIsPaused(false);
  };

  // 暂停训练
  const pauseTraining = () => {
    setIsPaused(true);
  };

  // 停止训练
  const stopTraining = () => {
    setIsTraining(false);
    setIsPaused(false);
  };

  // 重置训练
  const resetTraining = () => {
    setIsTraining(false);
    setIsPaused(false);
    setCurrentStep(0);
    setLogs([]);
    setLossHistory([]);
  };

  // 绘制 Loss 曲线
  const renderLossChart = () => {
    if (lossHistory.length < 2) return null;

    const width = 400;
    const height = 150;
    const padding = 30;

    const maxLoss = Math.max(...lossHistory, 6);
    const minLoss = Math.min(...lossHistory, 0);

    const points = lossHistory.map((loss, i) => {
      const x = padding + (i / (totalSteps - 1)) * (width - 2 * padding);
      const y = height - padding - ((loss - minLoss) / (maxLoss - minLoss)) * (height - 2 * padding);
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg width={width} height={height} className="w-full">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={padding}
            y1={height - padding - ratio * (height - 2 * padding)}
            x2={width - padding}
            y2={height - padding - ratio * (height - 2 * padding)}
            stroke="#27272a"
            strokeDasharray="4"
          />
        ))}

        {/* Loss curve */}
        <polyline
          points={points}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2"
        />

        {/* Current point */}
        {lossHistory.length > 0 && (
          <circle
            cx={padding + ((lossHistory.length - 1) / (totalSteps - 1)) * (width - 2 * padding)}
            cy={height - padding - ((currentLoss - minLoss) / (maxLoss - minLoss)) * (height - 2 * padding)}
            r="4"
            fill="#3b82f6"
          />
        )}

        {/* Axis labels */}
        <text x={padding} y={height - 8} className="text-xs fill-text-tertiary">Epoch 0</text>
        <text x={width - padding - 40} y={height - 8} className="text-xs fill-text-tertiary">Epoch {config.epochs}</text>
        <text x={8} y={padding + 10} className="text-xs fill-text-tertiary">{maxLoss.toFixed(1)}</text>
        <text x={8} y={height - padding} className="text-xs fill-text-tertiary">{minLoss.toFixed(2)}</text>
      </svg>
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：说明和配置 */}
        <div className="space-y-6">
          {/* 概念说明 */}
          <div className="p-4 rounded-xl bg-deep border border-border-default">
            <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-blue-400" />
              AI 怎么「练习」？
            </h3>
            <div className="space-y-3 text-sm text-text-secondary">
              <p>就像学生做练习题一样，AI 的学习过程是：</p>
              <ol className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-2xl">📝</span>
                  <span><span className="text-emerald-300 font-medium">做题：</span>看一句话，猜下一个字是什么</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">❌</span>
                  <span><span className="text-red-300 font-medium">对答案：</span>比较自己的猜测和正确答案，看差多少</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🔍</span>
                  <span><span className="text-amber-300 font-medium">找错因：</span>分析是哪里出了问题</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">✏️</span>
                  <span><span className="text-blue-300 font-medium">改正：</span>调整自己的「思路」，下次争取做对</span>
                </li>
              </ol>
              <p className="text-xs text-text-tertiary mt-2">
                💡 这个过程重复几万次，AI 就慢慢学会了！
              </p>
            </div>
          </div>

          {/* 学习设置 */}
          <div className="p-4 rounded-xl bg-deep border border-border-default">
            <h3 className="text-sm font-semibold text-text-primary mb-3">调整学习方式</h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-text-secondary">📚 每次看几道题</label>
                  <span className="text-xs font-bold text-emerald-400">{config.batchSize} 道</span>
                </div>
                <input
                  type="range"
                  min="8"
                  max="64"
                  step="8"
                  value={config.batchSize}
                  onChange={(e) => setConfig({ ...config, batchSize: Number(e.target.value) })}
                  disabled={isTraining}
                  className="w-full h-1.5 rounded-lg appearance-none bg-active cursor-pointer disabled:opacity-50"
                />
                <p className="text-xs text-text-disabled mt-1">一次看太多会消化不良，太少则学得慢</p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-text-secondary">🏃 改正的幅度</label>
                  <span className="text-xs font-bold text-blue-400">{config.learningRate > 0.001 ? '大步走' : config.learningRate > 0.0001 ? '中等' : '小碎步'}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={Math.log10(config.learningRate) + 5}
                  onChange={(e) => setConfig({ ...config, learningRate: Math.pow(10, Number(e.target.value) - 5) })}
                  disabled={isTraining}
                  className="w-full h-1.5 rounded-lg appearance-none bg-active cursor-pointer disabled:opacity-50"
                />
                <p className="text-xs text-text-disabled mt-1">步子太大容易摔，太小则进步慢</p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-text-secondary">🔄 复习几遍</label>
                  <span className="text-xs font-bold text-purple-400">{config.epochs} 遍</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="30"
                  step="5"
                  value={config.epochs}
                  onChange={(e) => setConfig({ ...config, epochs: Number(e.target.value) })}
                  disabled={isTraining}
                  className="w-full h-1.5 rounded-lg appearance-none bg-active cursor-pointer disabled:opacity-50"
                />
                <p className="text-xs text-text-disabled mt-1">好记性不如烂笔头，多练几遍记得牢</p>
              </div>
            </div>
          </div>

          {/* Loss 是什么 */}
          <div className="p-4 rounded-xl bg-deep border border-border-default">
            <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-amber-400" />
              Loss（错误率）是什么？
            </h3>
            <div className="space-y-3 text-sm text-text-secondary">
              <p>
                <span className="text-amber-400 font-medium">Loss</span> 就是 AI 的「错误程度」：
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
                  <div className="text-2xl font-bold text-red-400">5.8</div>
                  <div className="text-xs text-text-tertiary">刚开始：错得很离谱</div>
                </div>
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-center">
                  <div className="text-2xl font-bold text-emerald-400">0.02</div>
                  <div className="text-xs text-text-tertiary">训练后：几乎不出错</div>
                </div>
              </div>
              <p className="text-xs text-text-tertiary">
                💡 Loss 越低越好！我们的目标就是让这个数字尽可能小
              </p>
            </div>
          </div>
        </div>

        {/* 右侧：训练控制台 */}
        <div className="space-y-6">
          {/* 训练控制 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/20">
            <h3 className="text-sm font-semibold text-text-primary mb-4">训练控制</h3>

            {/* 控制按钮 */}
            <div className="flex gap-2 mb-4">
              {!isTraining || isPaused ? (
                <button
                  onClick={startTraining}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/30 transition-colors"
                >
                  <Play className="w-4 h-4" />
                  {currentStep > 0 ? '继续' : '开始训练'}
                </button>
              ) : (
                <button
                  onClick={pauseTraining}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-400 text-sm font-medium hover:bg-amber-500/30 transition-colors"
                >
                  <Pause className="w-4 h-4" />
                  暂停
                </button>
              )}

              <button
                onClick={stopTraining}
                disabled={!isTraining}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/30 disabled:opacity-50 transition-colors"
              >
                <Square className="w-4 h-4" />
                停止
              </button>

              <button
                onClick={resetTraining}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-hover border border-border-strong/50 text-text-secondary text-sm font-medium hover:bg-active transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                重置
              </button>
            </div>

            {/* 进度条 */}
            <div className="mb-4">
              <div className="flex justify-between text-xs text-text-tertiary mb-1">
                <span>Epoch {currentEpoch}/{config.epochs} | Step {stepInEpoch}/100</span>
                <span>{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-elevated rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-100"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {/* 实时指标 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-deep">
                <div className="text-2xl font-bold text-blue-400">{currentLoss.toFixed(4)}</div>
                <div className="text-xs text-text-tertiary">当前错误率</div>
              </div>
              <div className="p-3 rounded-lg bg-deep">
                <div className="text-2xl font-bold text-emerald-400">
                  {lossHistory.length > 1
                    ? ((1 - currentLoss / lossHistory[0]) * 100).toFixed(1)
                    : 0}%
                </div>
                <div className="text-xs text-text-tertiary">进步了多少</div>
              </div>
            </div>
          </div>

          {/* 错误率变化图 */}
          <div className="p-4 rounded-xl bg-deep border border-border-default">
            <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-blue-400" />
              错误率变化（越低越好）
            </h3>
            <div className="bg-void rounded-lg p-2">
              {lossHistory.length > 1 ? (
                renderLossChart()
              ) : (
                <div className="h-[150px] flex items-center justify-center text-sm text-text-disabled">
                  点击「开始训练」查看 AI 的进步过程 📈
                </div>
              )}
            </div>
          </div>

          {/* 训练记录 */}
          <div className="p-4 rounded-xl bg-deep border border-border-default">
            <h3 className="text-sm font-semibold text-text-primary mb-3">📋 学习记录</h3>
            <div className="space-y-1 max-h-40 overflow-y-auto text-xs">
              {logs.length > 0 ? (
                logs.map((log, i) => (
                  <div key={i} className="text-text-secondary p-1.5 rounded bg-surface">
                    第 <span className="text-blue-400 font-bold">{log.epoch}</span> 遍 |
                    {' '}做到第 <span className="text-purple-400">{log.step}</span> 题 |
                    {' '}错误率 <span className="text-emerald-400 font-bold">{log.loss.toFixed(4)}</span>
                  </div>
                ))
              ) : (
                <div className="text-text-disabled text-center py-4">等待开始训练...</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="mt-8 p-4 rounded-xl bg-deep border border-border-default">
        <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'Training Loop', zh: '训练循环', desc: '反复"做题-改正"的过程，直到模型学会' },
            { en: 'Epoch', zh: '轮次', desc: '完整遍历一次所有训练数据叫一个 epoch' },
            { en: 'Batch', zh: '批次', desc: '每次训练时同时处理的样本数量，不是一个个学而是一批批学' },
            { en: 'Loss', zh: '损失', desc: '衡量模型预测与正确答案差距的指标，越小越好' },
            { en: 'Learning Rate', zh: '学习率', desc: '每次调整参数的幅度，太大会震荡，太小学得慢' },
            { en: 'Gradient', zh: '梯度', desc: '指示参数应该往哪个方向调整的"指南针"' },
            { en: 'Backpropagation', zh: '反向传播', desc: '从输出层往回计算梯度的算法，找出每个参数的责任' },
            { en: 'Optimizer', zh: '优化器', desc: '根据梯度更新参数的策略，常用 Adam、SGD 等' },
          ].map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-surface">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-text-tertiary">|</span>
                <span className="text-sm text-text-secondary">{term.zh}</span>
              </div>
              <p className="text-xs text-text-tertiary">{term.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 导航按钮 */}
      <div className="mt-8 flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-elevated text-text-secondary font-medium hover:bg-active transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
        >
          下一步: 推理测试
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
