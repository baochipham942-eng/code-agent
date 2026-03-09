// ============================================================================
// NanoGPTLab - GPT-2 模型训练完整学习流程
// 支持两种模式：模拟学习 & 真实训练
// 重点：预训练 + 微调（后训练）
// ============================================================================

import React, { useState } from 'react';
import {
  Database,
  Type,
  Boxes,
  GraduationCap,
  Wrench,
  MessageSquare,
  Check,
  Sparkles,
  Cpu,
} from 'lucide-react';
import { DataPreparation } from './stages/DataPreparation';
import { Tokenizer } from './stages/Tokenizer';
import { ModelArchitecture } from './stages/ModelArchitecture';
import { Pretraining } from './stages/Pretraining';
import { Finetuning } from './stages/Finetuning';
import { Inference } from './stages/Inference';
import { RealModePanel } from './RealModePanel';

// 学习模式
export type LabMode = 'simulation' | 'real';

// 学习阶段定义
type Stage = 'data' | 'tokenizer' | 'architecture' | 'pretraining' | 'finetuning' | 'inference';

interface StageConfig {
  id: Stage;
  title: string;
  shortTitle: string;
  icon: React.ReactNode;
  description: string;
  learningPoint: string;
  isNew?: boolean;
}

const stages: StageConfig[] = [
  {
    id: 'data',
    title: '准备书籍',
    shortTitle: '书籍',
    icon: <Database className="w-4 h-4" />,
    description: '这次让 AI 读莎士比亚的全部作品，学习文学风格',
    learningPoint: '读的书越多、内容越丰富，AI 写出来的东西就越有深度',
  },
  {
    id: 'tokenizer',
    title: '更聪明的认字法',
    shortTitle: '认字',
    icon: <Type className="w-4 h-4" />,
    description: '这次用更高级的方法：常见的词组合成一个单位，节省空间',
    learningPoint: '就像我们认识"的"字后，可以直接认"的确"这个词，不用拆成两个字',
  },
  {
    id: 'architecture',
    title: '更大的大脑',
    shortTitle: '大脑',
    icon: <Boxes className="w-4 h-4" />,
    description: '大脑更大、层数更多，能学会更复杂的语言规律',
    learningPoint: '大脑越大、层数越多，能理解的内容就越复杂',
  },
  {
    id: 'pretraining',
    title: '博览群书',
    shortTitle: '阅读',
    icon: <GraduationCap className="w-4 h-4" />,
    description: '让 AI 大量阅读，学会语言的基本规律',
    learningPoint: '就像学生先广泛阅读打基础，再专攻某个领域',
  },
  {
    id: 'finetuning',
    title: '专攻某一领域',
    shortTitle: '专攻',
    icon: <Wrench className="w-4 h-4" />,
    description: '在博览群书的基础上，专门学习某种风格或任务',
    learningPoint: '先当"通才"再当"专才"——这就是现代 AI 训练的核心思路',
    isNew: true,
  },
  {
    id: 'inference',
    title: '让 AI 写作',
    shortTitle: '写作',
    icon: <MessageSquare className="w-4 h-4" />,
    description: '给一个开头，让 AI 用莎士比亚的风格继续写下去',
    learningPoint: '你可以控制 AI 写作的"创意程度"——是规规矩矩还是天马行空',
  },
];

export const NanoGPTLab: React.FC = () => {
  const [mode, setMode] = useState<LabMode>('simulation');
  const [currentStage, setCurrentStage] = useState<Stage>('data');
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
      case 'data':
        return <DataPreparation onComplete={goToNextStage} />;
      case 'tokenizer':
        return <Tokenizer onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'architecture':
        return <ModelArchitecture onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'pretraining':
        return <Pretraining onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'finetuning':
        return <Finetuning onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'inference':
        return <Inference onBack={goToPrevStage} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Mode Switcher */}
      <div className="px-6 py-3 border-b border-border-default bg-deep/30">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-surface p-1">
              <button
                onClick={() => setMode('simulation')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                  mode === 'simulation'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Sparkles className="w-4 h-4" />
                模拟学习
              </button>
              <button
                onClick={() => setMode('real')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                  mode === 'real'
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Cpu className="w-4 h-4" />
                真实训练
              </button>
            </div>
          </div>

          {/* Mode Description */}
          <div className="text-xs text-text-tertiary">
            {mode === 'simulation' ? (
              <span>📚 可视化演示，帮助理解 GPT-2 预训练与微调</span>
            ) : (
              <span>🔬 克隆 nanoGPT，执行真实训练</span>
            )}
          </div>
        </div>
      </div>

      {/* Real Mode Panel */}
      {mode === 'real' ? (
        <RealModePanel />
      ) : (
        <>
          {/* Progress Bar */}
          <div className="px-6 py-4 border-b border-border-default">
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
                      {/* New Badge */}
                      {stage.isNew && (
                        <span className="absolute -top-2 -right-2 px-1.5 py-0.5 text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded">
                          NEW
                        </span>
                      )}
                      <div
                        className={`
                          w-10 h-10 rounded-full flex items-center justify-center
                          transition-all duration-300
                          ${isCompleted ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : ''}
                          ${isCurrent ? 'bg-blue-500/20 border-blue-500/50 text-blue-400 ring-2 ring-blue-500/30' : ''}
                          ${!isCompleted && !isCurrent ? 'bg-surface border-border-default text-text-tertiary' : ''}
                          border
                        `}
                      >
                        {isCompleted ? <Check className="w-4 h-4" /> : stage.icon}
                      </div>
                      <span
                        className={`
                          text-xs font-medium
                          ${isCurrent ? 'text-blue-400' : isCompleted ? 'text-emerald-400' : 'text-text-tertiary'}
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
                            ${isPast || isCompleted ? 'bg-emerald-500/50' : 'bg-elevated'}
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
          <div className="px-6 py-4 bg-deep">
            <div className="max-w-5xl mx-auto">
              <div className="flex items-center gap-3 mb-2">
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    currentStageConfig.isNew
                      ? 'bg-amber-500/20 border border-amber-500/30 text-amber-400'
                      : 'bg-blue-500/20 border border-blue-500/30 text-blue-400'
                  }`}
                >
                  {currentStageConfig.icon}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-text-primary">
                      阶段 {currentStageIndex + 1}: {currentStageConfig.title}
                    </h2>
                    {currentStageConfig.isNew && (
                      <span className="px-2 py-0.5 text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded">
                        核心新增
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-text-tertiary">{currentStageConfig.description}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Stage Content */}
          <div className="flex-1 overflow-y-auto">{renderStageContent()}</div>

          {/* Learning Point Footer */}
          <div className="px-6 py-3 border-t border-border-default bg-deep/30">
            <div className="max-w-5xl mx-auto flex items-center gap-2">
              <span className="text-amber-400">💡</span>
              <span className="text-sm text-text-secondary">
                <span className="text-text-secondary font-medium">学习要点：</span>
                {currentStageConfig.learningPoint}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
