// ============================================================================
// PreferenceStage - 偏好优化方法
// DPO/KTO/ORPO/SimPO 原理与对比
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Heart,
  ThumbsUp,
  ThumbsDown,
  Zap,
  ArrowRight,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface PreferenceStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 偏好方法对比
function buildPreferenceMethods(t: Translations) {
  const m = t.labLlamafactory.preference.methods;
  return [
    { id: 'dpo', name: 'DPO', ...m.dpo, dataFormat: 'prompt + chosen + rejected', difficulty: 2, color: 'purple' },
    { id: 'kto', name: 'KTO', ...m.kto, dataFormat: 'prompt + response + label', difficulty: 2, color: 'blue' },
    { id: 'orpo', name: 'ORPO', ...m.orpo, dataFormat: 'prompt + chosen + rejected', difficulty: 2, color: 'emerald' },
    { id: 'simpo', name: 'SimPO', ...m.simpo, dataFormat: 'prompt + chosen + rejected', difficulty: 1, color: 'amber' },
  ];
}

// 偏好数据示例
// ponytail: prompt/chosen/rejected 是 DPO 偏好训练数据本身（一对 chosen/rejected 回答），
// 翻译会改变正在演示的训练数据语义，故不进 i18n。
const preferenceExample = {
  prompt: '请给我推荐一部电影',
  chosen: '我推荐《肖申克的救赎》！这是一部关于希望和自由的经典电影，讲述了银行家安迪在监狱中的故事。影片节奏紧凑，结局令人感动，非常值得一看。',
  rejected: '电影很多，你自己去网上搜吧。',
};

// SFT vs SFT+DPO 对比
// ponytail: prompt/sftOnly/sftPlusDpo 是模拟的模型输入输出内容（同上原因不迁移）；
// diff 是解释给用户看的对比说明，属 UI 文案，走 i18n（见组件内 buildComparisonExamples）。
const comparisonExampleData = {
  prompt: '如何看待加班文化？',
  sftOnly: '加班文化是指员工在正常工作时间之外继续工作的现象。它在很多公司中存在，有时是因为工作量大，有时是因为公司文化。加班有利有弊，可以提高产出但也会影响健康。',
  sftPlusDpo: '这是个值得深思的问题。首先我理解你可能正在经历加班困扰。\n\n从不同角度来看：\n1. 偶尔的项目冲刺可以理解\n2. 常态化加班往往意味着管理问题\n3. 身心健康应该是底线\n\n建议与上级坦诚沟通工作量，设定合理边界。你怎么看？',
};

function buildComparisonExamples(t: Translations) {
  return [{ ...comparisonExampleData, diff: t.labLlamafactory.preference.comparisonDiff }];
}

export const PreferenceStage: React.FC<PreferenceStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const p = t.labLlamafactory.preference;
  const preferenceMethods = buildPreferenceMethods(t);
  const comparisonExamples = buildComparisonExamples(t);
  const [selectedMethod, setSelectedMethod] = useState<string>('dpo');
  const [userChoice, setUserChoice] = useState<'chosen' | 'rejected' | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const getColorClasses = (color: string, _isActive: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string; ring: string }> = {
      purple: { bg: 'bg-purple-500/20', border: 'border-purple-500/30', text: 'text-purple-400', ring: 'ring-purple-500/30' },
      blue: { bg: 'bg-blue-500/20', border: 'border-blue-500/30', text: 'text-blue-400', ring: 'ring-blue-500/30' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/30', text: 'text-emerald-400', ring: 'ring-emerald-500/30' },
      amber: { bg: 'bg-amber-500/20', border: 'border-amber-500/30', text: 'text-amber-400', ring: 'ring-amber-500/30' },
    };
    return colors[color] || colors.purple;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Heart className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{p.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {p.introDescPart1}
              <span className="text-orange-400">{p.introDescHighlight}</span>{p.introDescPart2}
            </p>
          </div>
        </div>
      </div>

      {/* Preference Demo */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <ThumbsUp className="w-4 h-4 text-orange-400" />
          {p.demoSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          {/* Prompt */}
          <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <div className="text-xs text-blue-400 mb-1">{p.userQuestionLabel}</div>
            <p className="text-sm text-zinc-200">{preferenceExample.prompt}</p>
          </div>

          {/* Choices */}
          <div className="grid grid-cols-2 gap-4">
            {/* Chosen */}
            <button
              onClick={() => setUserChoice('chosen')}
              className={`
                p-4 rounded-lg border text-left transition-all
                ${userChoice === 'chosen'
                  ? 'bg-zinc-800/80 border-zinc-500 ring-1 ring-white/15'
                  : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                }
              `}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">A</span>
                {userChoice === 'chosen' && <ThumbsUp className="w-4 h-4 text-emerald-400" />}
              </div>
              <p className="text-sm text-zinc-400">{preferenceExample.chosen}</p>
            </button>

            {/* Rejected */}
            <button
              onClick={() => setUserChoice('rejected')}
              className={`
                p-4 rounded-lg border text-left transition-all
                ${userChoice === 'rejected'
                  ? 'bg-red-500/20 border-red-500/30 ring-2 ring-red-500/30'
                  : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                }
              `}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">B</span>
                {userChoice === 'rejected' && <ThumbsDown className="w-4 h-4 text-red-400" />}
              </div>
              <p className="text-sm text-zinc-400">{preferenceExample.rejected}</p>
            </button>
          </div>

          {/* Feedback */}
          {userChoice && (
            <div className={`
              mt-4 p-3 rounded-lg
              ${userChoice === 'chosen' ? 'bg-zinc-800/70 border border-zinc-600' : 'bg-amber-500/10 border border-amber-500/20'}
            `}>
              <p className="text-sm">
                {userChoice === 'chosen' ? (
                  <span className="text-emerald-400">
                    {p.feedbackChosen}
                  </span>
                ) : (
                  <span className="text-amber-400">
                    {p.feedbackRejected}
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Method Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Zap className="w-4 h-4 text-orange-400" />
          {p.methodsSectionTitle}
        </h3>
        <div className="grid grid-cols-4 gap-3">
          {preferenceMethods.map((method) => {
            const isSelected = selectedMethod === method.id;
            const colors = getColorClasses(method.color, isSelected);

            return (
              <button
                key={method.id}
                onClick={() => setSelectedMethod(method.id)}
                className={`
                  p-3 rounded-lg border text-left transition-all
                  ${isSelected
                    ? `${colors.bg} ${colors.border} ring-2 ${colors.ring}`
                    : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                  }
                `}
              >
                <div className={`text-lg font-bold ${isSelected ? colors.text : 'text-zinc-400'}`}>
                  {method.name}
                </div>
                <div className="text-xs text-zinc-500 mb-2">{method.zh}</div>
                <div className="flex items-center gap-0.5 mb-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <span
                      key={i}
                      className={`text-[10px] ${i < method.difficulty ? 'text-amber-400' : 'text-zinc-600'}`}
                    >
                      ★
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {/* Method Detail */}
        {selectedMethod && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
            {(() => {
              const method = preferenceMethods.find(m => m.id === selectedMethod)!;
              const colors = getColorClasses(method.color, true);
              return (
                <>
                  <div className="flex items-center gap-3 mb-3">
                    <span className={`text-xl font-bold ${colors.text}`}>{method.name}</span>
                    <span className="text-sm text-zinc-500">{method.fullName}</span>
                  </div>
                  <p className="text-sm text-zinc-400 mb-4">{method.description}</p>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-3 rounded-lg bg-zinc-800">
                      <div className="text-xs text-zinc-500 mb-2">{p.dataFormatLabel}</div>
                      <code className="text-xs text-orange-400">{method.dataFormat}</code>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-800">
                      <div className="text-xs text-emerald-400 mb-2">{p.prosLabel}</div>
                      <ul className="space-y-1">
                        {method.pros.map((pro, idx) => (
                          <li key={idx} className="text-xs text-zinc-400">+ {pro}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-800">
                      <div className="text-xs text-red-400 mb-2">{p.consLabel}</div>
                      <ul className="space-y-1">
                        {method.cons.map((con, idx) => (
                          <li key={idx} className="text-xs text-zinc-400">- {con}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* SFT vs SFT+DPO */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">{p.comparisonSectionTitle}</h3>
          <button
            onClick={() => setShowComparison(!showComparison)}
            className={`
              px-3 py-1.5 rounded-lg text-xs transition-all
              ${showComparison
                ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
              }
            `}
          >
            {showComparison ? p.hideComparisonButton : p.showComparisonButton}
          </button>
        </div>

        {showComparison && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
            {comparisonExamples.map((example, idx) => (
              <div key={idx}>
                <div className="mb-3 p-2 rounded bg-blue-500/10 border border-blue-500/20">
                  <span className="text-xs text-blue-400">{p.comparisonQuestionLabel}</span>
                  <span className="text-sm text-zinc-400 ml-2">{example.prompt}</span>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div className="p-3 rounded-lg bg-zinc-800 border border-zinc-800">
                    <div className="text-xs text-zinc-500 mb-2">{p.sftOnlyLabel}</div>
                    <p className="text-sm text-zinc-400 whitespace-pre-line">{example.sftOnly}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
                    <div className="text-xs text-purple-400 mb-2">{p.sftPlusDpoLabel}</div>
                    <p className="text-sm text-zinc-400 whitespace-pre-line">{example.sftPlusDpo}</p>
                  </div>
                </div>

                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20">
                  <span className="text-xs text-amber-400">💡 {example.diff}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Workflow */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{p.workflowSectionTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1 text-center p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="text-2xl mb-1">📝</div>
              <div className="text-sm font-medium text-blue-400">{p.workflowSft.title}</div>
              <div className="text-xs text-zinc-500">{p.workflowSft.desc}</div>
            </div>
            <ArrowRight className="w-6 h-6 text-zinc-600 mx-4" />
            <div className="flex-1 text-center p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="text-2xl mb-1">❤️</div>
              <div className="text-sm font-medium text-purple-400">{p.workflowDpo.title}</div>
              <div className="text-xs text-zinc-500">{p.workflowDpo.desc}</div>
            </div>
            <ArrowRight className="w-6 h-6 text-zinc-600 mx-4" />
            <div className="flex-1 text-center p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="text-2xl mb-1">✅</div>
              <div className="text-sm font-medium text-emerald-400">{p.workflowEval.title}</div>
              <div className="text-xs text-zinc-500">{p.workflowEval.desc}</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-zinc-500 text-center">
            {p.workflowHint}
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">{p.takeawaysTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {p.takeaways.map((item) => (
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
          {p.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {p.glossary.map((term) => (
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
          {p.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          {p.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
