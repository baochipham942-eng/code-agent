// ============================================================================
// RLHFStage - RLHF 与 RFT
// 奖励模型、PPO 流程、RFT 强化微调
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Brain,
  Trophy,
  Target,
  Zap,
  ArrowRight,
  Play,
  Pause,
  RotateCcw,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface RLHFStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// RLHF 三步流程
function buildRlhfSteps(t: Translations) {
  const s = t.labLlamafactory.rlhf.steps;
  return [
    { id: 'sft', ...s.sft, icon: '📝', color: 'blue' },
    { id: 'rm', ...s.rm, icon: '⭐', color: 'purple' },
    { id: 'ppo', ...s.ppo, icon: '🎯', color: 'emerald' },
  ];
}

// 方法对比
function buildMethodComparison(t: Translations) {
  const m = t.labLlamafactory.rlhf.methods;
  return [
    { name: 'RLHF', ...m.rlhf, steps: ['SFT', 'Reward Model', 'PPO'], color: 'purple' },
    { name: 'DPO', ...m.dpo, steps: ['SFT', 'DPO'], color: 'blue' },
    { name: 'RFT', ...m.rft, steps: ['SFT', ...t.labLlamafactory.rlhf.rftStepLabels], color: 'amber' },
  ];
}

// RFT 示例
// ponytail: question/solution 是 RFT 演示中"模型生成的解法/推理轨迹"本身，
// 属于喂给 Grader 验证的输入数据，翻译会改变演示内容，故不进 i18n。
const rftExample = {
  question: '计算 23 × 17 = ?',
  attempts: [
    { solution: '23 × 17 = 23 × 10 + 23 × 7 = 230 + 161 = 391', correct: true, reward: 1 },
    { solution: '23 × 17 = 20 × 17 + 3 × 17 = 340 + 41 = 381', correct: false, reward: -1 },
    { solution: '23 × 17 = 391', correct: true, reward: 1 },
  ],
  answer: 391,
};

export const RLHFStage: React.FC<RLHFStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const r = t.labLlamafactory.rlhf;
  const rlhfSteps = buildRlhfSteps(t);
  const methodComparison = buildMethodComparison(t);
  const [activeStep, setActiveStep] = useState<number>(0);
  const [isTraining, setIsTraining] = useState(false);
  const [rewardHistory, setRewardHistory] = useState<number[]>([0]);
  const [trainingStep, setTrainingStep] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 模拟 PPO 训练
  const toggleTraining = () => {
    if (isTraining) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsTraining(false);
      return;
    }

    setIsTraining(true);
    intervalRef.current = setInterval(() => {
      setTrainingStep((prev) => {
        if (prev >= 100) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setIsTraining(false);
          return 100;
        }
        return prev + 1;
      });

      setRewardHistory((prev) => {
        const step = prev.length;
        // 奖励逐渐上升并收敛
        const baseReward = 1 - Math.exp(-step * 0.05);
        const noise = (Math.random() - 0.5) * 0.1;
        return [...prev, Math.min(1, baseReward + noise)];
      });
    }, 100);
  };

  const resetTraining = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsTraining(false);
    setTrainingStep(0);
    setRewardHistory([0]);
  };

  // 绘制奖励曲线
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // 背景网格
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = (i / 5) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // 奖励曲线
    if (rewardHistory.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;

      rewardHistory.forEach((reward, idx) => {
        const x = (idx / 100) * width;
        const y = height - ((reward + 0.5) / 1.5) * height;

        if (idx === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    }
  }, [rewardHistory]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; border: string; text: string }> = {
      blue: { bg: 'bg-blue-500/20', border: 'border-blue-500/30', text: 'text-blue-400' },
      purple: { bg: 'bg-purple-500/20', border: 'border-purple-500/30', text: 'text-purple-400' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/30', text: 'text-emerald-400' },
      amber: { bg: 'bg-amber-500/20', border: 'border-amber-500/30', text: 'text-amber-400' },
    };
    return colors[color] || colors.blue;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Brain className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{r.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              <span className="text-orange-400">{r.introRlhfLabel}</span>{r.introRlhfText}
              <span className="text-orange-400">{r.introRftLabel}</span>{r.introRftText}
            </p>
          </div>
        </div>
      </div>

      {/* RLHF Three Steps */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Target className="w-4 h-4 text-orange-400" />
          {r.threeStepsSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-between mb-4">
            {rlhfSteps.map((step, index) => {
              const isActive = activeStep === index;
              const colors = getColorClasses(step.color);

              return (
                <React.Fragment key={step.id}>
                  <button
                    onClick={() => setActiveStep(index)}
                    className={`
                      flex-1 p-4 rounded-lg border transition-all text-center
                      ${isActive
                        ? `${colors.bg} ${colors.border} ring-2 ring-${step.color}-500/30`
                        : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                      }
                    `}
                  >
                    <div className="text-2xl mb-2">{step.icon}</div>
                    <div className={`text-sm font-medium ${isActive ? colors.text : 'text-zinc-400'}`}>
                      {step.title}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">{step.subtitle}</div>
                  </button>
                  {index < rlhfSteps.length - 1 && (
                    <ArrowRight className="w-5 h-5 text-zinc-600 mx-2 flex-shrink-0" />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Step Detail */}
          <div className="p-3 rounded-lg bg-zinc-800 border border-zinc-800">
            <p className="text-sm text-zinc-400">{rlhfSteps[activeStep].description}</p>
          </div>
        </div>
      </div>

      {/* PPO Training Simulation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <Trophy className="w-4 h-4 text-orange-400" />
            {r.ppoSimSectionTitle}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleTraining}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all
                ${isTraining
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                }
              `}
            >
              {isTraining ? (
                <>
                  <Pause className="w-4 h-4" />
                  {r.pauseButton}
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  {r.startPpoButton}
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{r.trainingStepsLabel}</div>
              <div className="text-xl font-bold text-orange-400">{trainingStep}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{r.currentRewardLabel}</div>
              <div className="text-xl font-bold text-emerald-400">
                {rewardHistory[rewardHistory.length - 1]?.toFixed(3) || '0.000'}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{r.statusLabel}</div>
              <div className={`text-lg font-medium ${
                isTraining ? 'text-amber-400' :
                trainingStep >= 100 ? 'text-emerald-400' : 'text-zinc-400'
              }`}>
                {isTraining ? r.statusOptimizing : trainingStep >= 100 ? r.statusConverged : r.statusReady}
              </div>
            </div>
          </div>

          {/* Reward Curve */}
          <div className="p-3 rounded-lg bg-zinc-950">
            <div className="text-xs text-zinc-500 mb-2">{r.rewardCurveLabel}</div>
            <canvas
              ref={canvasRef}
              width={600}
              height={120}
              className="w-full"
            />
          </div>

          <div className="mt-3 p-2 rounded bg-blue-500/10 border border-blue-500/20">
            <p className="text-xs text-blue-400">
              {r.ppoHint}
            </p>
          </div>
        </div>
      </div>

      {/* RFT Section */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Zap className="w-4 h-4 text-orange-400" />
          {r.rftSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-sm text-zinc-400">
              <span className="text-amber-400 font-medium">{r.rftLabel}</span> {r.rftIntroText}
            </p>
          </div>

          {/* RFT Example */}
          <div className="p-4 rounded-lg bg-zinc-800 border border-zinc-800">
            <div className="mb-3">
              <span className="text-xs text-zinc-500">{r.rftQuestionLabel}</span>
              <span className="text-sm text-zinc-200 ml-2">{rftExample.question}</span>
            </div>

            <div className="space-y-2">
              {rftExample.attempts.map((attempt, idx) => (
                <div
                  key={idx}
                  className={`
                    p-3 rounded-lg border
                    ${attempt.correct
                      ? 'bg-emerald-500/10 border-emerald-500/20'
                      : 'bg-red-500/10 border-red-500/20'
                    }
                  `}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-zinc-500">{r.rftAttemptLabel} {idx + 1}</span>
                    <span className={`text-xs font-medium ${attempt.correct ? 'text-emerald-400' : 'text-red-400'}`}>
                      {attempt.correct ? r.rftCorrect : r.rftIncorrect}
                    </span>
                  </div>
                  <code className="text-sm text-zinc-400">{attempt.solution}</code>
                </div>
              ))}
            </div>

            <div className="mt-3 text-xs text-zinc-500">
              {r.rftGraderVerifyLabel} {rftExample.answer}{r.rftGraderVerifySuffix}
            </div>
          </div>
        </div>
      </div>

      {/* Method Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{r.comparisonSectionTitle}</h3>
        <div className="grid grid-cols-3 gap-4">
          {methodComparison.map((method) => {
            const colors = getColorClasses(method.color);
            return (
              <div
                key={method.name}
                className={`p-4 rounded-lg border ${colors.bg} ${colors.border}`}
              >
                <div className={`text-lg font-bold ${colors.text} mb-1`}>{method.name}</div>
                <p className="text-xs text-zinc-500 mb-3">{method.description}</p>

                <div className="mb-3">
                  <div className="text-xs text-zinc-400 mb-1">{r.flowLabel}</div>
                  <div className="flex flex-wrap gap-1">
                    {method.steps.map((step, idx) => (
                      <React.Fragment key={step}>
                        <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{step}</span>
                        {idx < method.steps.length - 1 && <span className="text-zinc-600">→</span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-emerald-400">{r.prosLabel}</span>
                    <span className="text-zinc-400">{method.pros.join('、')}</span>
                  </div>
                  <div>
                    <span className="text-red-400">{r.consLabel}</span>
                    <span className="text-zinc-400">{method.cons.join('、')}</span>
                  </div>
                  <div className="pt-2 border-t border-zinc-800">
                    <span className="text-amber-400">{r.useCaseLabel}</span>
                    <span className="text-zinc-400">{method.useCase}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">{r.takeawaysTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {r.takeaways.map((item) => (
            <li key={item.label} className="flex items-start gap-2">
              <span className="text-orange-400">•</span>
              <span><strong className="text-zinc-400">{item.label}</strong>：{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 专有名词 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {r.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {r.glossary.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-400">{term.zh}</span>
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
          {r.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          {r.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
