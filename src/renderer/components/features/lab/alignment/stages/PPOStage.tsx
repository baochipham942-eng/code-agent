// ============================================================================
// PPOStage - PPO 训练阶段
// 用通俗方式介绍「让 AI 越来越好」
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

// PPO 流程步骤 - 用通俗方式解释
const ppoSteps = [
  {
    id: 'sample',
    name: '写回答',
    description: 'AI 尝试回答一个问题',
    icon: '✏️',
    simpleExplain: '就像学生做作业',
  },
  {
    id: 'reward',
    name: '打分',
    description: '用评分系统给回答打分',
    icon: '⭐',
    simpleExplain: '老师给作业打分',
  },
  {
    id: 'feedback',
    name: '找差距',
    description: '对比好答案和差答案的区别',
    icon: '🔍',
    simpleExplain: '分析为什么扣分',
  },
  {
    id: 'improve',
    name: '改进',
    description: '调整自己，下次写得更好',
    icon: '📈',
    simpleExplain: '纠正错误做法',
  },
  {
    id: 'balance',
    name: '保持稳定',
    description: '改进的同时不能忘了之前学的',
    icon: '⚖️',
    simpleExplain: '不能顾此失彼',
  },
];

// 模拟训练数据 - 简化展示
const simulatedTraining = [
  { step: 0, score: 30, improvement: '刚开始' },
  { step: 1, score: 45, improvement: '有进步' },
  { step: 2, score: 58, improvement: '继续加油' },
  { step: 3, score: 68, improvement: '越来越好' },
  { step: 4, score: 75, improvement: '快到了' },
  { step: 5, score: 82, improvement: '很棒了' },
  { step: 6, score: 87, improvement: '优秀' },
  { step: 7, score: 90, improvement: '非常好' },
  { step: 8, score: 92, improvement: '太棒了！' },
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
      }, 1500);
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
      }, 1200);
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
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🚀 让 AI 越来越好</h3>
            <p className="text-sm text-zinc-400">
              现在 AI 学会了「打分」，接下来就让它<span className="text-emerald-400">不断练习、不断进步</span>！
              就像运动员看自己的比赛录像，找出问题，然后改进。这个过程叫「强化学习」。
            </p>
          </div>
        </div>
      </div>

      {/* 打个比方 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">💡 打个比方</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-4 gap-3 text-center">
            <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
              <div className="text-2xl mb-1">🎾</div>
              <div className="text-xs text-blue-400">练习发球</div>
            </div>
            <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
              <div className="text-2xl mb-1">📊</div>
              <div className="text-xs text-amber-400">教练打分</div>
            </div>
            <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-2xl mb-1">🔧</div>
              <div className="text-xs text-purple-400">调整动作</div>
            </div>
            <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-2xl mb-1">🏆</div>
              <div className="text-xs text-emerald-400">越来越好</div>
            </div>
          </div>
          <div className="mt-3 p-3 bg-zinc-800/50 rounded-lg text-center">
            <p className="text-xs text-zinc-400">
              AI 也是这样：<span className="text-blue-400">写回答</span> →
              <span className="text-amber-400">打分</span> →
              <span className="text-purple-400">调整</span> →
              <span className="text-emerald-400">进步</span>，循环往复！
            </p>
          </div>
        </div>
      </div>

      {/* PPO Flow Animation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">🔄 AI 进步的循环</h3>
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
                  看 AI 学习
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
              <span className="text-xl">{ppoSteps[currentStepIndex].icon}</span>
              <span className="text-sm font-medium text-zinc-200">
                {ppoSteps[currentStepIndex].name}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                {ppoSteps[currentStepIndex].simpleExplain}
              </span>
            </div>
            <p className="text-sm text-zinc-400">{ppoSteps[currentStepIndex].description}</p>
          </div>
        </div>
      </div>

      {/* Training Progress - Simplified */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">📈 AI 的进步曲线</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-3 gap-4 text-center mb-4">
            <div>
              <div className="text-xs text-zinc-500 mb-1">学习轮次</div>
              <div className="text-2xl font-bold text-zinc-200">第 {currentTraining.step + 1} 轮</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">回答质量</div>
              <div className="text-2xl font-bold text-emerald-400">{currentTraining.score} 分</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">状态</div>
              <div className={`text-lg font-medium ${
                currentTraining.score >= 90 ? 'text-emerald-400' :
                currentTraining.score >= 70 ? 'text-blue-400' :
                currentTraining.score >= 50 ? 'text-amber-400' : 'text-zinc-400'
              }`}>
                {currentTraining.improvement}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>回答质量进步</span>
              <span className="text-emerald-400">{currentTraining.score}%</span>
            </div>
            <div className="h-4 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-500 via-emerald-500 to-emerald-400 transition-all duration-500"
                style={{ width: `${currentTraining.score}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-zinc-600">
              <span>0 分（很差）</span>
              <span>50 分（及格）</span>
              <span>100 分（满分）</span>
            </div>
          </div>
        </div>
      </div>

      {/* Key concept: Balance */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">⚖️ 一个重要的问题</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-red-500/10 rounded-lg border border-red-500/20">
              <div className="text-lg mb-2">😰 如果只追求高分...</div>
              <p className="text-sm text-zinc-400">
                AI 可能会「投机取巧」，只说一些讨好人的话，
                变得很假、很无聊，忘了自己本来会的东西。
              </p>
            </div>
            <div className="p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-lg mb-2">😊 所以要平衡...</div>
              <p className="text-sm text-zinc-400">
                既要追求高分，又不能变化太大。
                就像学生要进步，但也要保持自己的特点，不能变成「考试机器」。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Key Points */}
      <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
        <h4 className="text-sm font-medium text-emerald-400 mb-2">📌 小结</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          <li className="flex items-start gap-2">
            <span className="text-emerald-400">•</span>
            <span><strong className="text-zinc-300">练习 → 打分 → 改进</strong>：AI 通过不断循环来进步</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-emerald-400">•</span>
            <span><strong className="text-zinc-300">小步快跑</strong>：每次改进一点点，不能变化太大</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-emerald-400">•</span>
            <span><strong className="text-zinc-300">保持平衡</strong>：既要变好，又不能忘本</span>
          </li>
        </ul>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'PPO', zh: '近端策略优化', desc: 'Proximal Policy Optimization，一种稳定的强化学习算法' },
            { en: 'Reinforcement Learning', zh: '强化学习', desc: '通过奖励信号指导模型改进的学习方式' },
            { en: 'Policy', zh: '策略', desc: '模型生成回答的方式，PPO 优化的目标' },
            { en: 'KL Divergence', zh: 'KL 散度', desc: '衡量两个分布差异的指标，用于限制模型变化幅度' },
            { en: 'Reward', zh: '奖励', desc: '奖励模型给回答的评分，指导模型进步' },
            { en: 'Clipping', zh: '裁剪', desc: '限制单次更新幅度，防止模型变化过大' },
          ].map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800/50">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-300">{term.zh}</span>
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
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 border border-emerald-500/30 transition-all font-medium"
        >
          下一步：看 AI 的进步
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
