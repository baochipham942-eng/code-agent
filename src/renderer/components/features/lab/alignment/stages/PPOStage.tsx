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
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface PPOStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// PPO 流程步骤 - 用通俗方式解释
function buildPpoSteps(t: Translations) {
  const steps = t.labAlignment.ppo.steps;
  return [
    { id: 'sample', ...steps.sample, icon: '✏️' },
    { id: 'reward', ...steps.reward, icon: '⭐' },
    { id: 'feedback', ...steps.feedback, icon: '🔍' },
    { id: 'improve', ...steps.improve, icon: '📈' },
    { id: 'balance', ...steps.balance, icon: '⚖️' },
  ];
}

// 模拟训练数据 - 简化展示（分数为设计常量，进度文案随 locale）
function buildSimulatedTraining(t: Translations) {
  const status = t.labAlignment.ppo.trainingStatus;
  const scores = [30, 45, 58, 68, 75, 82, 87, 90, 92];
  return scores.map((score, step) => ({ step, score, improvement: status[step] }));
}

export const PPOStage: React.FC<PPOStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const s = t.labAlignment.ppo;
  const common = t.labAlignment.common;
  const ppoSteps = buildPpoSteps(t);
  const simulatedTraining = buildSimulatedTraining(t);
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
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{s.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {s.introPara1}<span className="text-emerald-400">{s.introHighlight}</span>
              {s.introPara2}
            </p>
          </div>
        </div>
      </div>

      {/* 打个比方 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{common.analogyTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-4 gap-3 text-center">
            <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
              <div className="text-2xl mb-1">🎾</div>
              <div className="text-xs text-blue-400">{s.analogyCards.practiceServe}</div>
            </div>
            <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
              <div className="text-2xl mb-1">📊</div>
              <div className="text-xs text-amber-400">{s.analogyCards.coachScores}</div>
            </div>
            <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-2xl mb-1">🔧</div>
              <div className="text-xs text-purple-400">{s.analogyCards.adjustMove}</div>
            </div>
            <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-2xl mb-1">🏆</div>
              <div className="text-xs text-emerald-400">{s.analogyCards.gettingBetter}</div>
            </div>
          </div>
          <div className="mt-3 p-3 bg-zinc-800 rounded-lg text-center">
            <p className="text-xs text-zinc-400">
              {s.cycleIntro}<span className="text-blue-400">{s.cycleWrite}</span> →
              <span className="text-amber-400">{s.cycleScore}</span> →
              <span className="text-purple-400">{s.cycleAdjust}</span> →
              <span className="text-emerald-400">{s.cycleImprove}</span>{s.cycleOutro}
            </p>
          </div>
        </div>
      </div>

      {/* PPO Flow Animation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">{s.loopSectionTitle}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetAnimation}
              className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
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
                  {s.pauseButton}
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  {s.watchButton}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Flow Steps */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-between">
            {ppoSteps.map((step, idx) => (
              <React.Fragment key={step.id}>
                <div
                  className={`flex-1 p-3 rounded-lg transition-all duration-500 ${
                    idx === currentStepIndex
                      ? 'bg-emerald-500/20 border border-emerald-500/30 scale-105'
                      : 'bg-zinc-800 border border-zinc-800'
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
          <div className="mt-4 pt-4 border-t border-zinc-700">
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
        <h3 className="text-sm font-medium text-zinc-400">{s.progressCurveSectionTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4 text-center mb-4">
            <div>
              <div className="text-xs text-zinc-500 mb-1">{s.roundLabel}</div>
              <div className="text-2xl font-bold text-zinc-200">{s.roundValue.replace('{round}', String(currentTraining.step + 1))}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">{s.qualityLabel}</div>
              <div className="text-2xl font-bold text-emerald-400">{s.scoreValue.replace('{score}', String(currentTraining.score))}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">{common.statusLabel}</div>
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
              <span>{s.qualityProgressLabel}</span>
              <span className="text-emerald-400">{currentTraining.score}%</span>
            </div>
            <div className="h-4 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-500 via-emerald-500 to-emerald-400 transition-all duration-500"
                style={{ width: `${currentTraining.score}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-zinc-600">
              <span>{s.scaleLabels.low}</span>
              <span>{s.scaleLabels.mid}</span>
              <span>{s.scaleLabels.high}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Key concept: Balance */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{s.balanceSectionTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-red-500/10 rounded-lg border border-red-500/20">
              <div className="text-lg mb-2">{s.onlyScoreTitle}</div>
              <p className="text-sm text-zinc-400">
                {s.onlyScoreText}
              </p>
            </div>
            <div className="p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-lg mb-2">{s.balanceTitle}</div>
              <p className="text-sm text-zinc-400">
                {s.balanceText}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Key Points */}
      <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
        <h4 className="text-sm font-medium text-emerald-400 mb-2">{common.summaryTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {s.summaryPoints.map((point) => (
            <li key={point.title} className="flex items-start gap-2">
              <span className="text-emerald-400">•</span>
              <span><strong className="text-zinc-400">{point.title}</strong>：{point.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {common.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {s.glossaryTerms.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-400">{term.meaning}</span>
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
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 border border-zinc-700 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          {common.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 border border-emerald-500/30 transition-all font-medium"
        >
          {s.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
