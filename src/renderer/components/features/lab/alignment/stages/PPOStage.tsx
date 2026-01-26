// ============================================================================
// PPOStage - PPO 训练阶段
// 展示 PPO 算法流程和 RLHF 训练过程
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
  ArrowRight,
  RefreshCw,
} from 'lucide-react';

interface PPOStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// PPO 流程步骤
const ppoSteps = [
  {
    id: 'sample',
    name: '采样',
    description: '从 prompt 数据集采样，用当前策略生成回答',
    icon: '📝',
    detail: 'π_θ(y|x) → 生成多个候选回答',
  },
  {
    id: 'reward',
    name: '计算奖励',
    description: '用奖励模型对生成的回答打分',
    icon: '🏆',
    detail: 'r = R_φ(x, y) 计算奖励分数',
  },
  {
    id: 'advantage',
    name: '计算优势',
    description: '计算 GAE 优势估计',
    icon: '📊',
    detail: 'A_t = δ_t + (γλ)δ_{t+1} + ...',
  },
  {
    id: 'update',
    name: '策略更新',
    description: '用 PPO-Clip 目标更新策略',
    icon: '🔄',
    detail: 'L^{CLIP} = min(r_t A_t, clip(r_t, 1-ε, 1+ε) A_t)',
  },
  {
    id: 'kl',
    name: 'KL 惩罚',
    description: '加入 KL 散度惩罚，防止偏离太远',
    icon: '⚖️',
    detail: 'L = L^{CLIP} - β KL(π_θ || π_ref)',
  },
];

// 模拟训练数据
const simulatedTraining = [
  { step: 0, reward: 0.12, kl: 0.001, policyLoss: 0.45 },
  { step: 50, reward: 0.28, kl: 0.012, policyLoss: 0.38 },
  { step: 100, reward: 0.41, kl: 0.025, policyLoss: 0.32 },
  { step: 150, reward: 0.52, kl: 0.038, policyLoss: 0.28 },
  { step: 200, reward: 0.61, kl: 0.045, policyLoss: 0.24 },
  { step: 250, reward: 0.68, kl: 0.052, policyLoss: 0.21 },
  { step: 300, reward: 0.73, kl: 0.058, policyLoss: 0.19 },
  { step: 350, reward: 0.76, kl: 0.062, policyLoss: 0.17 },
  { step: 400, reward: 0.78, kl: 0.065, policyLoss: 0.16 },
];

export const PPOStage: React.FC<PPOStageProps> = ({ onComplete, onBack }) => {
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [trainingIndex, setTrainingIndex] = useState(0);
  const animationRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trainingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // PPO 流程动画
  useEffect(() => {
    if (isAnimating) {
      animationRef.current = setInterval(() => {
        setCurrentStepIndex((prev) => (prev + 1) % ppoSteps.length);
      }, 2000);
    } else {
      if (animationRef.current) {
        clearInterval(animationRef.current);
      }
    }
    return () => {
      if (animationRef.current) clearInterval(animationRef.current);
    };
  }, [isAnimating]);

  // 模拟训练进度
  useEffect(() => {
    if (isAnimating && trainingIndex < simulatedTraining.length - 1) {
      trainingRef.current = setInterval(() => {
        setTrainingIndex((prev) => Math.min(prev + 1, simulatedTraining.length - 1));
      }, 1500);
    }
    return () => {
      if (trainingRef.current) clearInterval(trainingRef.current);
    };
  }, [isAnimating, trainingIndex]);

  const toggleAnimation = () => {
    setIsAnimating(!isAnimating);
  };

  const resetAnimation = () => {
    setIsAnimating(false);
    setCurrentStepIndex(0);
    setTrainingIndex(0);
    if (animationRef.current) clearInterval(animationRef.current);
    if (trainingRef.current) clearInterval(trainingRef.current);
  };

  const currentTraining = simulatedTraining[trainingIndex];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 rounded-lg border border-emerald-500/20 p-4">
        <div className="flex items-start gap-3">
          <Zap className="w-5 h-5 text-emerald-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">PPO 强化学习训练</h3>
            <p className="text-xs text-zinc-400">
              PPO (Proximal Policy Optimization) 是 RLHF 中使用的核心 RL 算法。它通过奖励模型的信号，
              优化语言模型策略，使其生成更符合人类偏好的回答，同时避免偏离原始模型太远。
            </p>
          </div>
        </div>
      </div>

      {/* PPO Flow Animation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">PPO 训练循环</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetAnimation}
              className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 border border-zinc-700/50"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleAnimation}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                isAnimating
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              }`}
            >
              {isAnimating ? (
                <>
                  <Pause className="w-4 h-4" />
                  暂停
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  开始演示
                </>
              )}
            </button>
          </div>
        </div>

        {/* Flow Steps */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-between">
            {ppoSteps.map((step, idx) => (
              <React.Fragment key={step.id}>
                <div
                  className={`flex-1 p-3 rounded-lg transition-all duration-500 ${
                    idx === currentStepIndex
                      ? 'bg-emerald-500/20 border border-emerald-500/30 scale-105'
                      : 'bg-zinc-800/30 border border-zinc-700/30'
                  }`}
                >
                  <div className="text-center">
                    <div className="text-2xl mb-1">{step.icon}</div>
                    <div
                      className={`text-xs font-medium ${
                        idx === currentStepIndex ? 'text-emerald-400' : 'text-zinc-400'
                      }`}
                    >
                      {step.name}
                    </div>
                  </div>
                </div>
                {idx < ppoSteps.length - 1 && (
                  <ArrowRight
                    className={`w-4 h-4 mx-1 ${
                      idx === currentStepIndex ? 'text-emerald-400' : 'text-zinc-600'
                    }`}
                  />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Current Step Detail */}
          <div className="mt-4 pt-4 border-t border-zinc-800/50">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">{ppoSteps[currentStepIndex].icon}</span>
              <span className="text-sm font-medium text-zinc-200">
                {ppoSteps[currentStepIndex].name}
              </span>
            </div>
            <p className="text-xs text-zinc-400 mb-2">{ppoSteps[currentStepIndex].description}</p>
            <code className="text-xs text-emerald-400 bg-zinc-950/50 px-2 py-1 rounded">
              {ppoSteps[currentStepIndex].detail}
            </code>
          </div>
        </div>
      </div>

      {/* Training Metrics */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">训练指标</h3>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
            <div className="text-xs text-zinc-500 mb-1">训练步数</div>
            <div className="text-xl font-mono text-zinc-200">{currentTraining.step}</div>
          </div>
          <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
            <div className="text-xs text-zinc-500 mb-1">平均奖励 ↑</div>
            <div className="text-xl font-mono text-emerald-400">{currentTraining.reward.toFixed(2)}</div>
          </div>
          <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
            <div className="text-xs text-zinc-500 mb-1">KL 散度</div>
            <div className="text-xl font-mono text-amber-400">{currentTraining.kl.toFixed(3)}</div>
          </div>
          <div className="bg-blue-500/5 rounded-lg border border-blue-500/20 p-4">
            <div className="text-xs text-zinc-500 mb-1">策略损失 ↓</div>
            <div className="text-xl font-mono text-blue-400">{currentTraining.policyLoss.toFixed(2)}</div>
          </div>
        </div>

        {/* Reward Progress Bar */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-zinc-500">奖励提升进度</span>
            <span className="text-xs text-emerald-400">
              {((currentTraining.reward / 0.8) * 100).toFixed(0)}%
            </span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
              style={{ width: `${(currentTraining.reward / 0.8) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Actor-Critic Architecture */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Actor-Critic 架构</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            {/* Actor */}
            <div className="bg-purple-500/5 rounded-lg border border-purple-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-purple-400" />
                <span className="text-sm font-medium text-purple-400">Actor (策略模型)</span>
              </div>
              <p className="text-xs text-zinc-400 mb-2">生成回答的语言模型，被 PPO 优化</p>
              <div className="text-xs text-zinc-500">
                <div>• 初始化自 SFT 模型</div>
                <div>• 输出 token 概率分布</div>
                <div>• 参数被梯度更新</div>
              </div>
            </div>

            {/* Critic */}
            <div className="bg-blue-500/5 rounded-lg border border-blue-500/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium text-blue-400">Critic (价值模型)</span>
              </div>
              <p className="text-xs text-zinc-400 mb-2">估计状态价值，用于计算优势</p>
              <div className="text-xs text-zinc-500">
                <div>• 预测累积奖励</div>
                <div>• 输出标量价值</div>
                <div>• 帮助减少方差</div>
              </div>
            </div>
          </div>

          {/* Reference Model */}
          <div className="mt-4 pt-4 border-t border-zinc-800/50">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-400">Reference Model (参考模型)</span>
            </div>
            <p className="text-xs text-zinc-500">
              冻结的 SFT 模型副本，用于计算 KL 惩罚。确保优化后的模型不会偏离原始模型太远，
              保持输出的多样性和流畅性。
            </p>
          </div>
        </div>
      </div>

      {/* Key Points */}
      <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
        <h4 className="text-sm font-medium text-emerald-400 mb-2">PPO 要点</h4>
        <ul className="space-y-1 text-xs text-zinc-400">
          <li>
            • <strong className="text-zinc-300">Clip 机制</strong>：限制策略更新幅度，保证训练稳定
          </li>
          <li>
            • <strong className="text-zinc-300">KL 惩罚</strong>：防止模型「collapse」到高奖励的单调回答
          </li>
          <li>
            • <strong className="text-zinc-300">奖励归一化</strong>：对奖励做白化处理，稳定训练
          </li>
          <li>
            • <strong className="text-zinc-300">GAE</strong>：广义优势估计，平衡偏差和方差
          </li>
        </ul>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步：奖励模型
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 border border-emerald-500/30 transition-all"
        >
          下一步：效果对比
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
