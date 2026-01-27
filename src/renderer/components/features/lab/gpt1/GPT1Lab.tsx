// ============================================================================
// GPT1Lab - GPT-1 模型训练完整学习流程
// 支持两种模式：模拟学习 & 真实训练
// ============================================================================

import React, { useState } from 'react';
import { Database, Type, Boxes, RotateCcw, MessageSquare, Check, Sparkles, Cpu } from 'lucide-react';
import { DataPreparation } from './stages/DataPreparation';
import { TokenizerStage } from './stages/TokenizerStage';
import { ModelArchitecture } from './stages/ModelArchitecture';
import { TrainingLoop } from './stages/TrainingLoop';
import { InferenceTest } from './stages/InferenceTest';
import { RealModePanel } from './RealModePanel';

// 学习模式
export type LabMode = 'simulation' | 'real';

// 学习阶段定义
type Stage = 'data' | 'tokenizer' | 'architecture' | 'training' | 'inference';

interface StageConfig {
  id: Stage;
  title: string;
  shortTitle: string;
  icon: React.ReactNode;
  description: string;
  learningPoint: string;
}

const stages: StageConfig[] = [
  {
    id: 'data',
    title: '给 AI 听对话',
    shortTitle: '听',
    icon: <Database className="w-4 h-4" />,
    description: '准备大量"你说、我说"的对话，让 AI 有东西可学',
    learningPoint: '就像小孩要先听大人说话，AI 也要先"听"大量对话才能学会',
  },
  {
    id: 'tokenizer',
    title: '教 AI 认字',
    shortTitle: '认字',
    icon: <Type className="w-4 h-4" />,
    description: '把文字拆成一个个小单位，让电脑能够处理',
    learningPoint: '电脑只认识数字，所以要把每个字/词变成数字',
  },
  {
    id: 'architecture',
    title: 'AI 的大脑',
    shortTitle: '大脑',
    icon: <Boxes className="w-4 h-4" />,
    description: '了解 AI 是怎么"思考"的，它的脑子里有什么',
    learningPoint: 'AI 大脑的核心能力：能同时关注句子里的多个词，理解它们的关系',
  },
  {
    id: 'training',
    title: '反复练习',
    shortTitle: '练习',
    icon: <RotateCcw className="w-4 h-4" />,
    description: '让 AI 一遍遍地猜下一个字，猜错了就改进',
    learningPoint: '训练就像做题：做错了看答案，记住正确答案，下次争取做对',
  },
  {
    id: 'inference',
    title: '让 AI 说话',
    shortTitle: '说话',
    icon: <MessageSquare className="w-4 h-4" />,
    description: '训练完成！和你亲手训练的 AI 聊天看看',
    learningPoint: 'AI 说话时会一个字一个字地往外"蹦"，每个字都是它猜的最可能的下一个字',
  },
];

export const GPT1Lab: React.FC = () => {
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
        return <TokenizerStage onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'architecture':
        return <ModelArchitecture onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'training':
        return <TrainingLoop onComplete={goToNextStage} onBack={goToPrevStage} />;
      case 'inference':
        return <InferenceTest onBack={goToPrevStage} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Mode Switcher */}
      <div className="px-6 py-3 border-b border-zinc-800/50 bg-zinc-900/30">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-zinc-800/50 p-1">
              <button
                onClick={() => setMode('simulation')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                  mode === 'simulation'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
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
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Cpu className="w-4 h-4" />
                真实训练
              </button>
            </div>
          </div>

          {/* Mode Description */}
          <div className="text-xs text-zinc-500">
            {mode === 'simulation' ? (
              <span>📚 可视化演示，帮助理解原理</span>
            ) : (
              <span>🔬 下载项目，执行真实训练</span>
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
          <div className="px-6 py-4 border-b border-zinc-800/50">
            <div className="flex items-center justify-between max-w-4xl mx-auto">
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
                        flex flex-col items-center gap-2 group
                        ${isCurrent ? 'opacity-100' : 'opacity-60 hover:opacity-80'}
                        transition-opacity
                      `}
                    >
                      <div
                        className={`
                          w-10 h-10 rounded-full flex items-center justify-center
                          transition-all duration-300
                          ${isCompleted ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : ''}
                          ${isCurrent ? 'bg-blue-500/20 border-blue-500/50 text-blue-400 ring-2 ring-blue-500/30' : ''}
                          ${!isCompleted && !isCurrent ? 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500' : ''}
                          border
                        `}
                      >
                        {isCompleted ? <Check className="w-4 h-4" /> : stage.icon}
                      </div>
                      <span
                        className={`
                          text-xs font-medium
                          ${isCurrent ? 'text-blue-400' : isCompleted ? 'text-emerald-400' : 'text-zinc-500'}
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
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  {currentStageConfig.icon}
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">
                    阶段 {currentStageIndex + 1}: {currentStageConfig.title}
                  </h2>
                  <p className="text-sm text-zinc-500">{currentStageConfig.description}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Stage Content */}
          <div className="flex-1 overflow-y-auto">
            {renderStageContent()}
          </div>

          {/* Learning Point Footer */}
          <div className="px-6 py-3 border-t border-zinc-800/50 bg-zinc-900/30">
            <div className="max-w-4xl mx-auto flex items-center gap-2">
              <span className="text-amber-400">💡</span>
              <span className="text-sm text-zinc-400">
                <span className="text-zinc-300 font-medium">学习要点：</span>
                {currentStageConfig.learningPoint}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
