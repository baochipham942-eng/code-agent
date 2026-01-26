// ============================================================================
// AlignmentLab - 对齐技术学习模块
// 包含 SFT（监督微调）和 RLHF（人类反馈强化学习）
// ============================================================================

import React, { useState } from 'react';
import {
  GraduationCap,
  Users,
  Brain,
  MessageSquare,
  Check,
  Sparkles,
} from 'lucide-react';
import { SFTStage } from './stages/SFTStage';
import { RewardModelStage } from './stages/RewardModelStage';
import { PPOStage } from './stages/PPOStage';
import { AlignmentComparison } from './stages/AlignmentComparison';

// 学习阶段定义
type Stage = 'sft' | 'reward' | 'ppo' | 'comparison';

interface StageConfig {
  id: Stage;
  title: string;
  shortTitle: string;
  icon: React.ReactNode;
  description: string;
  learningPoint: string;
  difficulty: 1 | 2 | 3 | 4;
}

const stages: StageConfig[] = [
  {
    id: 'sft',
    title: '监督微调 (SFT)',
    shortTitle: 'SFT',
    icon: <GraduationCap className="w-4 h-4" />,
    description: '使用指令-响应对训练模型遵循指令',
    learningPoint: 'SFT 让模型学会理解和执行人类指令',
    difficulty: 2,
  },
  {
    id: 'reward',
    title: '奖励模型',
    shortTitle: 'Reward',
    icon: <Users className="w-4 h-4" />,
    description: '训练模型预测人类偏好',
    learningPoint: '奖励模型量化"好"与"坏"的区别',
    difficulty: 3,
  },
  {
    id: 'ppo',
    title: 'PPO 优化',
    shortTitle: 'PPO',
    icon: <Brain className="w-4 h-4" />,
    description: '使用强化学习优化策略',
    learningPoint: 'PPO 在保持稳定的同时最大化奖励',
    difficulty: 4,
  },
  {
    id: 'comparison',
    title: '效果对比',
    shortTitle: '对比',
    icon: <MessageSquare className="w-4 h-4" />,
    description: '对比不同阶段模型的输出差异',
    learningPoint: '对齐让模型输出更有帮助、更安全',
    difficulty: 1,
  },
];

export const AlignmentLab: React.FC = () => {
  const [currentStage, setCurrentStage] = useState<Stage>('sft');
  const [completedStages, setCompletedStages] = useState<Set<Stage>>(new Set());

  const currentStageIndex = stages.findIndex((s) => s.id === currentStage);
  const currentStageConfig = stages[currentStageIndex];

  // 标记阶段完成
  const markStageComplete = (stage: Stage) => {
    setCompletedStages((prev) => new Set(prev).add(stage));
  };

  // 导航到下一阶段
  const goToNextStage = () => {
    markStageComplete(currentStage);
    if (currentStageIndex < stages.length - 1) {
      setCurrentStage(stages[currentStageIndex + 1].id);
    }
  };

  // 导航到上一阶段
  const goToPrevStage = () => {
    if (currentStageIndex > 0) {
      setCurrentStage(stages[currentStageIndex - 1].id);
    }
  };

  // 渲染阶段内容
  const renderStageContent = () => {
    switch (currentStage) {
      case 'sft':
        return <SFTStage onComplete={goToNextStage} />;
      case 'reward':
        return <RewardModelStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'ppo':
        return <PPOStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'comparison':
        return <AlignmentComparison onBack={goToPrevStage} />;
      default:
        return null;
    }
  };

  // 难度星星
  const renderDifficulty = (level: number) => {
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <span
            key={i}
            className={`text-[10px] ${i < level ? 'text-amber-400' : 'text-zinc-700'}`}
          >
            ★
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span className="text-sm text-zinc-300">概念演示模式</span>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
              无需真实训练
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            📚 通过可视化理解 RLHF 对齐流程
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="px-6 py-4 border-b border-zinc-800/50">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          {stages.map((stage, index) => {
            const isCompleted = completedStages.has(stage.id);
            const isCurrent = stage.id === currentStage;
            const isPast = index < currentStageIndex;

            return (
              <React.Fragment key={stage.id}>
                {/* Stage Node */}
                <button
                  onClick={() => setCurrentStage(stage.id)}
                  className={`
                    flex flex-col items-center gap-2 group relative
                    ${isCurrent ? 'opacity-100' : 'opacity-60 hover:opacity-80'}
                    transition-opacity
                  `}
                >
                  {/* Difficulty Badge */}
                  <div className="absolute -top-1 -right-1">
                    {renderDifficulty(stage.difficulty)}
                  </div>

                  <div
                    className={`
                      w-12 h-12 rounded-full flex items-center justify-center
                      transition-all duration-300
                      ${isCompleted ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : ''}
                      ${isCurrent ? 'bg-purple-500/20 border-purple-500/50 text-purple-400 ring-2 ring-purple-500/30' : ''}
                      ${!isCompleted && !isCurrent ? 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500' : ''}
                      border
                    `}
                  >
                    {isCompleted ? <Check className="w-5 h-5" /> : stage.icon}
                  </div>
                  <span
                    className={`
                      text-xs font-medium
                      ${isCurrent ? 'text-purple-400' : isCompleted ? 'text-emerald-400' : 'text-zinc-500'}
                    `}
                  >
                    {stage.shortTitle}
                  </span>
                </button>

                {/* Connector Line */}
                {index < stages.length - 1 && (
                  <div className="flex-1 mx-3">
                    <div
                      className={`
                        h-0.5 rounded-full transition-colors duration-300
                        ${isPast || isCompleted ? 'bg-emerald-500/50' : 'bg-zinc-800'}
                      `}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Stage Header */}
      <div className="px-6 py-4 bg-zinc-900/50">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
              {currentStageConfig.icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-zinc-100">
                  阶段 {currentStageIndex + 1}: {currentStageConfig.title}
                </h2>
                {renderDifficulty(currentStageConfig.difficulty)}
              </div>
              <p className="text-sm text-zinc-500">{currentStageConfig.description}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Stage Content */}
      <div className="flex-1 overflow-y-auto">{renderStageContent()}</div>

      {/* Learning Point Footer */}
      <div className="px-6 py-3 border-t border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto flex items-center gap-2">
          <span className="text-purple-400">💡</span>
          <span className="text-sm text-zinc-400">
            <span className="text-zinc-300 font-medium">学习要点：</span>
            {currentStageConfig.learningPoint}
          </span>
        </div>
      </div>
    </div>
  );
};
