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

interface PracticeStageProps {
  onBack: () => void;
}

// 场景选择题
const scenarios = [
  {
    id: 1,
    question: '你想让客服机器人学会公司特有的业务知识和回答风格',
    options: [
      { label: 'SFT', correct: true, reason: '新增领域知识是 SFT 的强项' },
      { label: 'DPO', correct: false, reason: 'DPO 主要用于调整风格偏好，不太适合注入新知识' },
      { label: 'RLHF', correct: false, reason: '太复杂了，SFT 就够用' },
    ],
  },
  {
    id: 2,
    question: '模型会回答问题，但回答太冷漠，想让它更友好、更有帮助',
    options: [
      { label: 'SFT', correct: false, reason: 'SFT 不太擅长调整"风格"' },
      { label: 'DPO', correct: true, reason: '偏好优化正是调整风格的最佳选择' },
      { label: 'RFT', correct: false, reason: 'RFT 用于推理能力，不是风格' },
    ],
  },
  {
    id: 3,
    question: '数学解题模型经常算错，想提高准确率',
    options: [
      { label: 'SFT', correct: false, reason: 'SFT 可以帮助，但不如 RFT 针对性强' },
      { label: 'DPO', correct: false, reason: 'DPO 不擅长提升推理能力' },
      { label: 'RFT', correct: true, reason: 'RFT 专门用于提升可验证任务的推理能力' },
    ],
  },
  {
    id: 4,
    question: '想用最少的资源在 24GB 显卡上微调 7B 模型',
    options: [
      { label: '全量微调', correct: false, reason: '显存不够，7B 全量需要 40GB+' },
      { label: 'LoRA', correct: false, reason: '可行但不是最省' },
      { label: 'QLoRA', correct: true, reason: 'QLoRA 是显存最省的方案，24GB 足够' },
    ],
  },
];

// 完整流程总结
const workflowSummary = [
  { step: 1, title: '确定目标', desc: '新增能力 → SFT | 调整风格 → DPO | 提升推理 → RFT', icon: '🎯' },
  { step: 2, title: '准备数据', desc: '50-100 条高质量数据起步，质量比数量重要', icon: '📊' },
  { step: 3, title: '选择方法', desc: 'QLoRA 最省资源，LoRA 平衡，全量追求极致', icon: '⚙️' },
  { step: 4, title: '训练监控', desc: '关注 Loss 曲线，防止过拟合', icon: '📈' },
  { step: 5, title: '模型合并', desc: 'LoRA 权重合并到基座，导出完整模型', icon: '🔗' },
  { step: 6, title: '评估部署', desc: '验证集测试 + 人工评估，确认后部署', icon: '🚀' },
];

// 导出格式
const exportFormats = [
  { name: 'Hugging Face', desc: 'safetensors 格式，最通用', icon: '🤗' },
  { name: 'GGUF', desc: 'llama.cpp 格式，本地推理', icon: '🦙' },
  { name: 'vLLM', desc: '高性能推理服务', icon: '⚡' },
  { name: 'ONNX', desc: '跨平台部署', icon: '📦' },
];

export const PracticeStage: React.FC<PracticeStageProps> = ({ onBack }) => {
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
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🏆 综合实践</h3>
            <p className="text-sm text-zinc-400">
              恭喜你学完了所有理论知识！现在来做几道选择题，检验一下学习成果，
              然后了解模型合并和部署流程。
            </p>
          </div>
        </div>
      </div>

      {/* Quiz Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-orange-400" />
            场景选择测验
          </h3>
          {!quizCompleted && (
            <span className="text-xs text-zinc-500">
              {currentQuestion + 1} / {scenarios.length}
            </span>
          )}
        </div>

        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
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

                  let bgClass = 'bg-zinc-800/30 border-zinc-700/30 hover:border-zinc-600';
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
                        <span className="text-sm text-zinc-300">{option.label}</span>
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
                  {currentQuestion < scenarios.length - 1 ? '下一题' : '查看结果'}
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
                得分：{correctCount} / {scenarios.length}
              </div>
              <p className="text-sm text-zinc-400 mb-4">
                {correctCount === scenarios.length
                  ? '完美！你已经掌握了微调的核心知识！'
                  : correctCount >= scenarios.length / 2
                    ? '不错！再复习一下之前的内容会更好。'
                    : '建议回顾之前的阶段，加深理解。'}
              </p>
              <button
                onClick={resetQuiz}
                className="flex items-center gap-2 px-4 py-2 mx-auto rounded-lg bg-zinc-800/50 text-zinc-400 border border-zinc-700/50 hover:bg-zinc-800 transition-all text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                重新测验
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Model Merge */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-orange-400" />
          模型合并
        </h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="mb-4">
            <p className="text-sm text-zinc-400 mb-3">
              LoRA 训练后会得到一个小的权重文件（adapter）。要部署时，需要把它合并到基座模型中。
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
              {showMergeAnimation ? '✓ 合并完成' : '演示合并'}
            </button>
          </div>

          {/* Merge Animation */}
          <div className="flex items-center justify-center gap-4 py-4">
            <div className={`
              p-4 rounded-lg border text-center transition-all duration-500
              ${showMergeAnimation ? 'opacity-50' : 'bg-zinc-800/50 border-zinc-700/30'}
            `}>
              <div className="text-2xl mb-1">🦙</div>
              <div className="text-xs text-zinc-400">基座模型</div>
              <div className="text-xs text-zinc-500">7B 参数</div>
            </div>

            <div className="text-zinc-600">+</div>

            <div className={`
              p-4 rounded-lg border text-center transition-all duration-500
              ${showMergeAnimation ? 'opacity-50' : 'bg-blue-500/10 border-blue-500/20'}
            `}>
              <div className="text-2xl mb-1">🎯</div>
              <div className="text-xs text-blue-400">LoRA 权重</div>
              <div className="text-xs text-zinc-500">~10MB</div>
            </div>

            <ArrowRight className={`w-6 h-6 transition-all duration-500 ${showMergeAnimation ? 'text-emerald-400' : 'text-zinc-600'}`} />

            <div className={`
              p-4 rounded-lg border text-center transition-all duration-500
              ${showMergeAnimation
                ? 'bg-emerald-500/10 border-emerald-500/30 scale-110'
                : 'bg-zinc-800/50 border-zinc-700/30'
              }
            `}>
              <div className="text-2xl mb-1">✨</div>
              <div className={`text-xs ${showMergeAnimation ? 'text-emerald-400' : 'text-zinc-400'}`}>合并后模型</div>
              <div className="text-xs text-zinc-500">7B 参数</div>
            </div>
          </div>

          <div className="text-xs text-zinc-500 text-center">
            合并公式：W_merged = W_base + B × A × scaling
          </div>
        </div>
      </div>

      {/* Export Formats */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Rocket className="w-4 h-4 text-orange-400" />
          导出与部署
        </h3>
        <div className="grid grid-cols-4 gap-3">
          {exportFormats.map((format) => (
            <div key={format.name} className="p-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50 text-center">
              <div className="text-2xl mb-2">{format.icon}</div>
              <div className="text-sm font-medium text-zinc-300">{format.name}</div>
              <div className="text-xs text-zinc-500 mt-1">{format.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Complete Workflow */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">📋 完整工作流总结</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-3 gap-4">
            {workflowSummary.map((item) => (
              <div key={item.step} className="p-3 rounded-lg bg-zinc-800/30 border border-zinc-700/30">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{item.icon}</span>
                  <span className="text-sm font-medium text-zinc-300">{item.step}. {item.title}</span>
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
        <h3 className="text-lg font-bold text-emerald-400 mb-2">恭喜完成学习！</h3>
        <p className="text-sm text-zinc-400 mb-4">
          你已经了解了 LLaMA Factory 微调的完整流程：从 SFT 到 RLHF/DPO，从 LoRA 到部署。
          现在可以动手实践了！
        </p>
        <div className="flex items-center justify-center gap-4">
          <a
            href="https://github.com/hiyouga/LLaMA-Factory"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-zinc-800/50 text-zinc-300 border border-zinc-700/50 hover:bg-zinc-800 transition-all text-sm"
          >
            访问 LLaMA Factory
          </a>
          <a
            href="https://platform.openai.com/docs/guides/fine-tuning"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-zinc-800/50 text-zinc-300 border border-zinc-700/50 hover:bg-zinc-800 transition-all text-sm"
          >
            OpenAI 微调指南
          </a>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">📌 全课程总结</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-300">微调是工具</strong>：先优化 prompt，实在不够再考虑微调</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-300">数据决定上限</strong>：高质量数据比大量数据更重要</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-300">选对方法</strong>：新能力用 SFT，调风格用 DPO，练推理用 RFT</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-300">资源高效</strong>：QLoRA 让消费级显卡也能微调大模型</span>
          </li>
        </ul>
      </div>

      {/* Navigation */}
      <div className="flex justify-start pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
      </div>
    </div>
  );
};
