// ============================================================================
// PracticeStage - 综合实践
// 工作流选择、模型合并、评估部署
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronLeft,
  Trophy,
  GitMerge,
  CheckCircle,
  Rocket,
  HelpCircle,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface PracticeStageProps {
  onBack: () => void;
}

// 场景选择题
function buildScenarios(t: Translations) {
  return t.labLlamafactory.practice.scenarios.map((sc, idx) => ({
    id: idx + 1,
    question: sc.question,
    options: sc.options.map((opt) => ({ ...opt, correct: opt.label === correctLabels[idx] })),
  }));
}
// 每题的正确答案标签（与 i18n 词条里的选项顺序一一对应）
const correctLabels = ['SFT', 'DPO', 'RFT', 'QLoRA'];

// 完整流程总结
function buildWorkflowSummary(t: Translations) {
  const icons = ['🎯', '📊', '⚙️', '📈', '🔗', '🚀'];
  return t.labLlamafactory.practice.workflowSteps.map((step, idx) => ({
    step: idx + 1,
    ...step,
    icon: icons[idx],
  }));
}

// 导出格式
function buildExportFormats(t: Translations) {
  const f = t.labLlamafactory.practice.exportFormats;
  return [
    { ...f.huggingface, icon: '🤗' },
    { ...f.gguf, icon: '🦙' },
    { ...f.vllm, icon: '⚡' },
    { ...f.onnx, icon: '📦' },
  ];
}

export const PracticeStage: React.FC<PracticeStageProps> = ({ onBack }) => {
  const { t } = useI18n();
  const p = t.labLlamafactory.practice;
  const scenarios = buildScenarios(t);
  const workflowSummary = buildWorkflowSummary(t);
  const exportFormats = buildExportFormats(t);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [showMergeAnimation, setShowMergeAnimation] = useState(false);

  const handleAnswer = (optionIndex: number) => {
    if (showResult) return;

    setSelectedAnswer(optionIndex);
    setShowResult(true);

    if (scenarios[currentQuestion].options[optionIndex].correct) {
      setCorrectCount((prev) => prev + 1);
    }
  };

  const nextQuestion = () => {
    if (currentQuestion < scenarios.length - 1) {
      setCurrentQuestion((prev) => prev + 1);
      setSelectedAnswer(null);
      setShowResult(false);
    } else {
      setQuizCompleted(true);
    }
  };

  const resetQuiz = () => {
    setCurrentQuestion(0);
    setSelectedAnswer(null);
    setShowResult(false);
    setCorrectCount(0);
    setQuizCompleted(false);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Trophy className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{p.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {p.introDesc}
            </p>
          </div>
        </div>
      </div>

      {/* Quiz Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-orange-400" />
            {p.quizSectionTitle}
          </h3>
          {!quizCompleted && (
            <span className="text-xs text-zinc-500">
              {currentQuestion + 1} / {scenarios.length}
            </span>
          )}
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          {!quizCompleted ? (
            <>
              {/* Question */}
              <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <p className="text-sm text-zinc-200">{scenarios[currentQuestion].question}</p>
              </div>

              {/* Options */}
              <div className="space-y-2 mb-4">
                {scenarios[currentQuestion].options.map((option, idx) => {
                  const isSelected = selectedAnswer === idx;
                  const isCorrect = option.correct;

                  let bgClass = 'bg-zinc-800 border-zinc-800 hover:border-zinc-600';
                  if (showResult) {
                    if (isCorrect) {
                      bgClass = 'bg-emerald-500/20 border-emerald-500/30';
                    } else if (isSelected && !isCorrect) {
                      bgClass = 'bg-red-500/20 border-red-500/30';
                    }
                  } else if (isSelected) {
                    bgClass = 'bg-orange-500/20 border-orange-500/30';
                  }

                  return (
                    <button
                      key={idx}
                      onClick={() => handleAnswer(idx)}
                      disabled={showResult}
                      className={`w-full p-3 rounded-lg border text-left transition-all ${bgClass}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-zinc-400">{option.label}</span>
                        {showResult && isCorrect && (
                          <CheckCircle className="w-4 h-4 text-emerald-400" />
                        )}
                      </div>
                      {showResult && (
                        <p className="text-xs text-zinc-500 mt-1">{option.reason}</p>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Next Button */}
              {showResult && (
                <button
                  onClick={nextQuestion}
                  className="w-full py-2 rounded-lg bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30 transition-all text-sm"
                >
                  {currentQuestion < scenarios.length - 1 ? p.nextQuestionButton : p.viewResultButton}
                </button>
              )}
            </>
          ) : (
            /* Quiz Result */
            <div className="text-center py-6">
              <div className="text-4xl mb-4">
                {correctCount === scenarios.length ? '🎉' : correctCount >= scenarios.length / 2 ? '👍' : '📚'}
              </div>
              <div className="text-xl font-bold text-zinc-200 mb-2">
                {p.scoreLabel}{correctCount} / {scenarios.length}
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                {correctCount === scenarios.length
                  ? p.resultPerfect
                  : correctCount >= scenarios.length / 2
                    ? p.resultGood
                    : p.resultNeedsReview}
              </p>
              <button
                onClick={resetQuiz}
                className="flex items-center gap-2 px-4 py-2 mx-auto rounded-lg bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700 transition-all text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                {p.retryButton}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Model Merge */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-orange-400" />
          {p.mergeSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="mb-4">
            <p className="text-sm text-zinc-400 mb-3">
              {p.mergeDesc}
            </p>
            <button
              onClick={() => setShowMergeAnimation(true)}
              disabled={showMergeAnimation}
              className={`
                px-4 py-2 rounded-lg text-sm transition-all
                ${showMergeAnimation
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30'
                }
              `}
            >
              {showMergeAnimation ? p.mergeDoneButton : p.mergeDemoButton}
            </button>
          </div>

          {/* Merge Animation */}
          <div className="flex items-center justify-center gap-4 py-4">
            <div className={`
              p-4 rounded-lg border text-center transition-all duration-500
              ${showMergeAnimation ? 'opacity-50' : 'bg-zinc-800 border-zinc-800'}
            `}>
              <div className="text-2xl mb-1">🦙</div>
              <div className="text-xs text-zinc-400">{p.mergeBaseModel}</div>
              <div className="text-xs text-zinc-500">{p.mergeBaseModelParams}</div>
            </div>

            <div className="text-zinc-600">+</div>

            <div className={`
              p-4 rounded-lg border text-center transition-all duration-500
              ${showMergeAnimation ? 'opacity-50' : 'bg-blue-500/10 border-blue-500/20'}
            `}>
              <div className="text-2xl mb-1">🎯</div>
              <div className="text-xs text-blue-400">{p.mergeLoraWeights}</div>
              <div className="text-xs text-zinc-500">{p.mergeLoraSize}</div>
            </div>

            <ArrowRight className={`w-6 h-6 transition-all duration-500 ${showMergeAnimation ? 'text-emerald-400' : 'text-zinc-600'}`} />

            <div className={`
              p-4 rounded-lg border text-center transition-all duration-500
              ${showMergeAnimation
                ? 'bg-emerald-500/10 border-emerald-500/30 scale-110'
                : 'bg-zinc-800 border-zinc-800'
              }
            `}>
              <div className="text-2xl mb-1">✨</div>
              <div className={`text-xs ${showMergeAnimation ? 'text-emerald-400' : 'text-zinc-400'}`}>{p.mergedModel}</div>
              <div className="text-xs text-zinc-500">{p.mergedModelParams}</div>
            </div>
          </div>

          <div className="text-xs text-zinc-500 text-center">
            {p.mergeFormula}
          </div>
        </div>
      </div>

      {/* Export Formats */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Rocket className="w-4 h-4 text-orange-400" />
          {p.exportSectionTitle}
        </h3>
        <div className="grid grid-cols-4 gap-3">
          {exportFormats.map((format) => (
            <div key={format.name} className="p-3 rounded-lg bg-zinc-900 border border-zinc-700 text-center">
              <div className="text-2xl mb-2">{format.icon}</div>
              <div className="text-sm font-medium text-zinc-400">{format.name}</div>
              <div className="text-xs text-zinc-500 mt-1">{format.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Complete Workflow */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{p.workflowSectionTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4">
            {workflowSummary.map((item) => (
              <div key={item.step} className="p-3 rounded-lg bg-zinc-800 border border-zinc-800">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{item.icon}</span>
                  <span className="text-sm font-medium text-zinc-400">{item.step}. {item.title}</span>
                </div>
                <p className="text-xs text-zinc-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Congratulations */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 rounded-lg border border-emerald-500/20 p-6 text-center">
        <div className="text-4xl mb-3">🎓</div>
        <h3 className="text-lg font-bold text-emerald-400 mb-2">{p.congratsTitle}</h3>
        <p className="text-sm text-zinc-400 mb-4">
          {p.congratsDesc}
        </p>
        <div className="flex items-center justify-center gap-4">
          <a
            href="https://github.com/hiyouga/LLaMA-Factory"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700 transition-all text-sm"
          >
            {p.visitLlamaFactoryLink}
          </a>
          <a
            href="https://platform.openai.com/docs/guides/fine-tuning"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700 transition-all text-sm"
          >
            {p.visitOpenAiGuideLink}
          </a>
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

      {/* Navigation */}
      <div className="flex justify-start pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 border border-zinc-700 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          {p.backButton}
        </button>
      </div>
    </div>
  );
};
