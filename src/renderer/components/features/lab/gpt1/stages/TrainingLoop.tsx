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
        <text x={padding} y={height - 8} className="text-xs fill-zinc-500">Epoch 0</text>
        <text x={width - padding - 40} y={height - 8} className="text-xs fill-zinc-500">Epoch {config.epochs}</text>
        <text x={8} y={padding + 10} className="text-xs fill-zinc-500">{maxLoss.toFixed(1)}</text>
        <text x={8} y={height - padding} className="text-xs fill-zinc-500">{minLoss.toFixed(2)}</text>
      </svg>
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：说明和配置 */}
        <div className="space-y-6">
          {/* 概念说明 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-blue-400" />
              训练循环是什么？
            </h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <p>训练循环是模型学习的核心过程，每一步都包含：</p>
              <ol className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">1.</span>
                  <span><span className="text-zinc-300">前向传播：</span>输入数据，得到模型预测</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">2.</span>
                  <span><span className="text-zinc-300">计算损失：</span>比较预测和真实答案的差距</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">3.</span>
                  <span><span className="text-zinc-300">反向传播：</span>计算每个参数对损失的贡献</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">4.</span>
                  <span><span className="text-zinc-300">参数更新：</span>调整参数以减小损失</span>
                </li>
              </ol>
            </div>
          </div>

          {/* 超参数配置 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">超参数配置</h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-500">Batch Size</label>
                  <span className="text-xs font-mono text-emerald-400">{config.batchSize}</span>
                </div>
                <input
                  type="range"
                  min="8"
                  max="64"
                  step="8"
                  value={config.batchSize}
                  onChange={(e) => setConfig({ ...config, batchSize: Number(e.target.value) })}
                  disabled={isTraining}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-700 cursor-pointer disabled:opacity-50"
                />
                <p className="text-xs text-zinc-600 mt-1">每次训练使用的样本数量</p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-500">Learning Rate</label>
                  <span className="text-xs font-mono text-blue-400">{config.learningRate.toExponential(0)}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={Math.log10(config.learningRate) + 5}
                  onChange={(e) => setConfig({ ...config, learningRate: Math.pow(10, Number(e.target.value) - 5) })}
                  disabled={isTraining}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-700 cursor-pointer disabled:opacity-50"
                />
                <p className="text-xs text-zinc-600 mt-1">参数更新的步长大小</p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-500">Epochs</label>
                  <span className="text-xs font-mono text-purple-400">{config.epochs}</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="30"
                  step="5"
                  value={config.epochs}
                  onChange={(e) => setConfig({ ...config, epochs: Number(e.target.value) })}
                  disabled={isTraining}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-700 cursor-pointer disabled:opacity-50"
                />
                <p className="text-xs text-zinc-600 mt-1">完整遍历数据集的次数</p>
              </div>
            </div>
          </div>

          {/* 代码展示 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">{'</>'}</span>
              train.py (训练循环)
            </h3>
            <pre className="font-mono text-xs bg-zinc-950 rounded-lg p-3 overflow-x-auto text-zinc-300">
{`# 优化器
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=${config.learningRate.toExponential(0)}
)

# 训练循环
for epoch in range(${config.epochs}):
    for step in range(steps_per_epoch):
        # 1. 获取批次数据
        x, y = dataset.get_batch(${config.batchSize})

        # 2. 前向传播
        logits = model(x)

        # 3. 计算损失
        loss = F.cross_entropy(
            logits.view(-1, vocab_size),
            y.view(-1)
        )

        # 4. 反向传播
        optimizer.zero_grad()
        loss.backward()

        # 5. 参数更新
        optimizer.step()

        print(f"Epoch {epoch} | Loss {loss:.4f}")`}
            </pre>
          </div>
        </div>

        {/* 右侧：训练控制台 */}
        <div className="space-y-6">
          {/* 训练控制 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4">训练控制</h3>

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
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-700/50 border border-zinc-600/50 text-zinc-400 text-sm font-medium hover:bg-zinc-700 transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                重置
              </button>
            </div>

            {/* 进度条 */}
            <div className="mb-4">
              <div className="flex justify-between text-xs text-zinc-500 mb-1">
                <span>Epoch {currentEpoch}/{config.epochs} | Step {stepInEpoch}/100</span>
                <span>{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-100"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {/* 实时指标 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-zinc-900/50">
                <div className="text-2xl font-bold text-blue-400">{currentLoss.toFixed(4)}</div>
                <div className="text-xs text-zinc-500">当前 Loss</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900/50">
                <div className="text-2xl font-bold text-emerald-400">
                  {lossHistory.length > 1
                    ? ((1 - currentLoss / lossHistory[0]) * 100).toFixed(1)
                    : 0}%
                </div>
                <div className="text-xs text-zinc-500">Loss 下降</div>
              </div>
            </div>
          </div>

          {/* Loss 曲线 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-blue-400" />
              Loss 曲线
            </h3>
            <div className="bg-zinc-950 rounded-lg p-2">
              {lossHistory.length > 1 ? (
                renderLossChart()
              ) : (
                <div className="h-[150px] flex items-center justify-center text-sm text-zinc-600">
                  开始训练后显示 Loss 变化曲线
                </div>
              )}
            </div>
          </div>

          {/* 训练日志 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">训练日志</h3>
            <div className="space-y-1 max-h-40 overflow-y-auto font-mono text-xs">
              {logs.length > 0 ? (
                logs.map((log, i) => (
                  <div key={i} className="text-zinc-400">
                    <span className="text-zinc-600">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    {' '}Epoch <span className="text-blue-400">{log.epoch}</span>/
                    {config.epochs} | Step <span className="text-purple-400">{log.step}</span>/100
                    {' '}| Loss <span className="text-emerald-400">{log.loss.toFixed(4)}</span>
                  </div>
                ))
              ) : (
                <div className="text-zinc-600">等待训练开始...</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 导航按钮 */}
      <div className="mt-8 flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-zinc-800 text-zinc-300 font-medium hover:bg-zinc-700 transition-colors"
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
