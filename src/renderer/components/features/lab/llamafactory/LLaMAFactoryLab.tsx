// ============================================================================
// LLaMAFactoryLab - LLaMA Factory 微调教学模块
// 让用户通过模拟交互掌握大模型微调的关键技术
// ============================================================================

import React, { useState } from 'react';
import {
  Map,
  Layers,
  GraduationCap,
  Heart,
  Brain,
  Trophy,
  Check,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import type { Translations } from '../../../../i18n/zh';
import { IntroStage } from './stages/IntroStage';
import { MethodStage } from './stages/MethodStage';
import { SFTStage } from './stages/SFTStage';
import { PreferenceStage } from './stages/PreferenceStage';
import { RLHFStage } from './stages/RLHFStage';
import { PracticeStage } from './stages/PracticeStage';

// 学习阶段定义
type Stage = 'intro' | 'method' | 'sft' | 'preference' | 'rlhf' | 'practice';

interface StageConfig {
  id: Stage;
  title: string;
  shortTitle: string;
  icon: React.ReactNode;
  description: string;
  learningPoint: string;
  difficulty: 1 | 2 | 3 | 4;
}

function buildStages(t: Translations): StageConfig[] {
  const s = t.labLlamafactory.lab.stages;
  return [
    {
      id: 'intro',
      ...s.intro,
      icon: <Map className="w-4 h-4" />,
      difficulty: 1,
    },
    {
      id: 'method',
      ...s.method,
      icon: <Layers className="w-4 h-4" />,
      difficulty: 2,
    },
    {
      id: 'sft',
      ...s.sft,
      icon: <GraduationCap className="w-4 h-4" />,
      difficulty: 3,
    },
    {
      id: 'preference',
      ...s.preference,
      icon: <Heart className="w-4 h-4" />,
      difficulty: 3,
    },
    {
      id: 'rlhf',
      ...s.rlhf,
      icon: <Brain className="w-4 h-4" />,
      difficulty: 4,
    },
    {
      id: 'practice',
      ...s.practice,
      icon: <Trophy className="w-4 h-4" />,
      difficulty: 2,
    },
  ];
}

export const LLaMAFactoryLab: React.FC = () => {
  const { t } = useI18n();
  const stages = buildStages(t);
  const [currentStage, setCurrentStage] = useState<Stage>('intro');
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
      case 'intro':
        return <IntroStage onComplete={goToNextStage} />;
      case 'method':
        return <MethodStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'sft':
        return <SFTStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'preference':
        return <PreferenceStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'rlhf':
        return <RLHFStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'practice':
        return <PracticeStage onBack={goToPrevStage} />;
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
            className={`text-[10px] ${i < level ? 'text-amber-400' : 'text-zinc-600'}`}
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
      <div className="px-6 py-3 border-b border-zinc-700 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-400" />
            <span className="text-sm text-zinc-400">{t.labLlamafactory.lab.conceptDemoMode}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">
              {t.labLlamafactory.lab.noRealTrainingNeeded}
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            {t.labLlamafactory.lab.footerTagline}
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="px-6 py-4 border-b border-zinc-700">
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
                      ${isCurrent ? 'bg-orange-500/20 border-orange-500/50 text-orange-400 ring-2 ring-orange-500/30' : ''}
                      ${!isCompleted && !isCurrent ? 'bg-zinc-800 border-zinc-700 text-zinc-500' : ''}
                      border
                    `}
                  >
                    {isCompleted ? <Check className="w-5 h-5" /> : stage.icon}
                  </div>
                  <span
                    className={`
                      text-xs font-medium
                      ${isCurrent ? 'text-orange-400' : isCompleted ? 'text-emerald-400' : 'text-zinc-500'}
                    `}
                  >
                    {stage.shortTitle}
                  </span>
                </button>

                {/* Connector Line */}
                {index < stages.length - 1 && (
                  <div className="flex-1 mx-2">
                    <div
                      className={`
                        h-0.5 rounded-full transition-colors duration-300
                        ${isPast || isCompleted ? 'bg-emerald-500/50' : 'bg-zinc-700'}
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
      <div className="px-6 py-4 bg-zinc-900">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-orange-500/20 border border-orange-500/30 flex items-center justify-center text-orange-400">
              {currentStageConfig.icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-zinc-200">
                  {t.labLlamafactory.lab.stagePrefix} {currentStageIndex + 1}: {currentStageConfig.title}
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
      <div className="px-6 py-3 border-t border-zinc-700 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto flex items-center gap-2">
          <span className="text-orange-400">💡</span>
          <span className="text-sm text-zinc-400">
            <span className="text-zinc-400 font-medium">{t.labLlamafactory.lab.learningPointLabel}</span>
            {currentStageConfig.learningPoint}
          </span>
        </div>
      </div>
    </div>
  );
};
