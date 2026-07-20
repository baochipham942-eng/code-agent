// ============================================================================
// IntroStage - 微调全景图
// 介绍微调技术栈总览、各方法定位、LLaMA Factory
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronRight,
  Map,
  Check,
  X,
  Lightbulb,
  ArrowRight,
  Layers,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface IntroStageProps {
  onComplete: () => void;
}

// 微调技术栈流程
function buildPipelineSteps(t: Translations) {
  const p = t.labLlamafactory.intro.pipeline;
  return [
    { id: 'pretrain', ...p.pretrain, subtitle: 'Pre-training', icon: '📚', color: 'zinc' },
    { id: 'sft', ...p.sft, subtitle: 'Supervised Fine-Tuning', icon: '📝', color: 'blue' },
    { id: 'alignment', ...p.alignment, subtitle: 'RLHF / DPO', icon: '❤️', color: 'purple' },
    { id: 'eval', ...p.eval, subtitle: 'Evaluation & Deploy', icon: '🚀', color: 'emerald' },
  ];
}

// 微调目标分类
function buildFinetuningGoals(t: Translations) {
  const g = t.labLlamafactory.intro.goals;
  return [
    { ...g.knowledge, method: 'SFT', icon: '🎓', color: 'blue' },
    { ...g.style, method: 'DPO / PPO', icon: '❤️', color: 'purple' },
    { ...g.reasoning, method: 'RFT', icon: '🧠', color: 'amber' },
  ];
}

export const IntroStage: React.FC<IntroStageProps> = ({ onComplete }) => {
  const { t } = useI18n();
  const i = t.labLlamafactory.intro;
  const pipelineSteps = buildPipelineSteps(t);
  const finetuningGoals = buildFinetuningGoals(t);
  const canDo = i.canDo;
  const cannotDo = i.cannotDo;
  const featureIcons = ['🦙', '⚙️', '📊', '🖥️'];
  const llamaFactoryFeatures = i.features.map((f, idx) => ({ ...f, icon: featureIcons[idx] }));
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [expandedDecision, setExpandedDecision] = useState<'can' | 'cannot' | null>(null);

  const getColorClasses = (color: string, _isActive: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string }> = {
      zinc: { bg: 'bg-zinc-600/20', border: 'border-zinc-600/30', text: 'text-zinc-400' },
      blue: { bg: 'bg-blue-500/20', border: 'border-blue-500/30', text: 'text-blue-400' },
      purple: { bg: 'bg-purple-500/20', border: 'border-purple-500/30', text: 'text-purple-400' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/30', text: 'text-emerald-400' },
      amber: { bg: 'bg-amber-500/20', border: 'border-amber-500/30', text: 'text-amber-400' },
      orange: { bg: 'bg-orange-500/20', border: 'border-orange-500/30', text: 'text-orange-400' },
    };
    return colors[color] || colors.zinc;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Map className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{i.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {i.introDesc}
            </p>
          </div>
        </div>
      </div>

      {/* Pipeline Overview */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Layers className="w-4 h-4 text-orange-400" />
          {i.pipelineSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-between gap-2">
            {pipelineSteps.map((step, index) => {
              const isSelected = selectedStep === step.id;
              const colors = getColorClasses(step.color, isSelected);

              return (
                <React.Fragment key={step.id}>
                  <button
                    onClick={() => setSelectedStep(isSelected ? null : step.id)}
                    className={`
                      flex-1 p-3 rounded-lg border transition-all text-center
                      ${isSelected
                        ? `${colors.bg} ${colors.border} ring-2 ring-${step.color}-500/30`
                        : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                      }
                    `}
                  >
                    <div className="text-2xl mb-2">{step.icon}</div>
                    <div className={`text-sm font-medium ${isSelected ? colors.text : 'text-zinc-400'}`}>
                      {step.title}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">{step.subtitle}</div>
                  </button>
                  {index < pipelineSteps.length - 1 && (
                    <ArrowRight className="w-4 h-4 text-zinc-600 flex-shrink-0" />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Detail Panel */}
          {selectedStep && (
            <div className="mt-4 p-3 rounded-lg bg-zinc-800 border border-zinc-800">
              <p className="text-sm text-zinc-400">
                {pipelineSteps.find(s => s.id === selectedStep)?.detail}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Fine-tuning Goals */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-orange-400" />
          {i.goalsSectionTitle}
        </h3>
        <div className="grid grid-cols-3 gap-4">
          {finetuningGoals.map((item) => {
            const colors = getColorClasses(item.color, true);
            return (
              <div
                key={item.goal}
                className={`p-4 rounded-lg border ${colors.bg} ${colors.border}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">{item.icon}</span>
                  <span className={`text-sm font-medium ${colors.text}`}>{item.goal}</span>
                </div>
                <div className="text-xs text-zinc-400 mb-2">{i.recommendedMethodLabel}<span className="text-zinc-200">{item.method}</span></div>
                <ul className="space-y-1">
                  {item.examples.map((ex, idx) => (
                    <li key={idx} className="text-xs text-zinc-500 flex items-center gap-1">
                      <span className="text-zinc-600">•</span> {ex}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {/* Can / Cannot Do */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Check className="w-4 h-4 text-orange-400" />
          {i.canCannotSectionTitle}
        </h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Can Do */}
          <div
            className={`
              rounded-lg border transition-all cursor-pointer
              ${expandedDecision === 'can'
                ? 'bg-emerald-500/10 border-emerald-500/30'
                : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
              }
            `}
            onClick={() => setExpandedDecision(expandedDecision === 'can' ? null : 'can')}
          >
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <Check className="w-3 h-3 text-emerald-400" />
                </div>
                <span className="text-sm font-medium text-emerald-400">{i.canDoLabel}</span>
              </div>
              <ul className="space-y-2">
                {canDo.map((item, idx) => (
                  <li key={idx} className="text-sm text-zinc-400">
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <div>
                        <span>{item.text}</span>
                        {expandedDecision === 'can' && (
                          <div className="text-xs text-zinc-500 mt-0.5">{i.exampleLabel}{item.example}</div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Cannot Do */}
          <div
            className={`
              rounded-lg border transition-all cursor-pointer
              ${expandedDecision === 'cannot'
                ? 'bg-red-500/10 border-red-500/30'
                : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
              }
            `}
            onClick={() => setExpandedDecision(expandedDecision === 'cannot' ? null : 'cannot')}
          >
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-red-500/20 flex items-center justify-center">
                  <X className="w-3 h-3 text-red-400" />
                </div>
                <span className="text-sm font-medium text-red-400">{i.cannotDoLabel}</span>
              </div>
              <ul className="space-y-2">
                {cannotDo.map((item, idx) => (
                  <li key={idx} className="text-sm text-zinc-400">
                    <div className="flex items-start gap-2">
                      <span className="text-red-400 mt-1">✗</span>
                      <div>
                        <span>{item.text}</span>
                        {expandedDecision === 'cannot' && (
                          <div className="text-xs text-zinc-500 mt-0.5">{i.exampleLabel}{item.example}</div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="text-xs text-zinc-500 text-center">
          {i.canCannotHint}
        </div>
      </div>

      {/* LLaMA Factory Introduction */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <span className="text-lg">🦙</span>
          {i.llamaFactorySectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <p className="text-sm text-zinc-400 mb-4">
            {i.llamaFactoryDesc}
          </p>
          <div className="grid grid-cols-4 gap-3">
            {llamaFactoryFeatures.map((feature) => (
              <div key={feature.title} className="p-3 rounded-lg bg-zinc-800 border border-zinc-800 text-center">
                <div className="text-2xl mb-2">{feature.icon}</div>
                <div className="text-sm font-medium text-zinc-400">{feature.title}</div>
                <div className="text-xs text-zinc-500 mt-1">{feature.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">{i.takeawaysTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {i.takeaways.map((item) => (
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
          {i.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {i.glossary.map((term) => (
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
      <div className="flex justify-end pt-4">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          {i.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
