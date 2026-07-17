// ============================================================================
// RewardModelStage - 奖励模型阶段
// 用通俗方式介绍「教 AI 分辨好坏」
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  ThumbsUp,
  ThumbsDown,
  Scale,
  Trophy,
  Sparkles,
  BarChart3,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

interface RewardModelStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 偏好对比数据 - 更贴近生活的例子
const preferenceExamples = [
  {
    prompt: '我今天心情不好',
    responseA: '心情不好是一种负面情绪状态，建议你运动或者早点休息。',
    responseB: '抱抱～有什么想说的吗？如果不想说也没关系，我陪着你 💙',
    preferredResponse: 'B',
    reason: '回答 B 更有温度，表达了关心和陪伴',
    labelA: '机械',
    labelB: '温暖',
  },
  {
    prompt: '推荐一部电影',
    responseA: '《肖申克的救赎》，豆瓣评分 9.7，讲述囚犯安迪的故事。',
    responseB: '你喜欢什么类型的呀？治愈系、刺激冒险、还是烧脑悬疑？告诉我你现在的心情，我帮你挑一个最适合的！',
    preferredResponse: 'B',
    reason: '回答 B 更贴心，先了解用户需求再推荐',
    labelA: '直接给答案',
    labelB: '先问再答',
  },
  {
    prompt: '怎么做番茄炒蛋？',
    responseA: '番茄切块，鸡蛋打散，先炒蛋再炒番茄。',
    responseB: '番茄炒蛋超简单！\n\n1. 番茄切小块（熟一点的更好吃）\n2. 鸡蛋打散，加一点点盐\n3. 油热后先炒蛋，嫩一点就盛出来\n4. 再炒番茄，软了加蛋翻两下\n5. 加盐，喜欢甜口加点糖\n\n小技巧：蛋不要炒老了，嫩嫩的最好吃！',
    preferredResponse: 'B',
    reason: '回答 B 步骤清晰，还有实用小技巧',
    labelA: '太简略',
    labelB: '详细实用',
  },
];

export const RewardModelStage: React.FC<RewardModelStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const s = t.labAlignment.reward;
  const common = t.labAlignment.common;
  const [currentExample, setCurrentExample] = useState(0);
  const [userChoice, setUserChoice] = useState<'A' | 'B' | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);

  const example = preferenceExamples[currentExample];

  // 处理用户选择
  const handleChoice = (choice: 'A' | 'B') => {
    setUserChoice(choice);
    setShowResult(true);
    if (choice === example.preferredResponse) {
      setCorrectCount(prev => prev + 1);
    }
  };

  // 下一个示例
  const nextExample = () => {
    if (currentExample < preferenceExamples.length - 1) {
      setCurrentExample((prev) => prev + 1);
      setUserChoice(null);
      setShowResult(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-lg border border-amber-500/20 p-4">
        <div className="flex items-start gap-3">
          <Trophy className="w-5 h-5 text-amber-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{s.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {s.introPara1}
              <span className="text-amber-400">{s.introHighlight}</span>
              {s.introPara2}
            </p>
          </div>
        </div>
      </div>

      {/* 打个比方 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{common.analogyTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="p-4 bg-zinc-800 rounded-lg border border-zinc-800">
              <div className="text-3xl mb-2">👨‍🏫</div>
              <div className="text-sm font-medium text-zinc-400">{s.analogyCards.teacherGivesTwo.label}</div>
              <div className="text-xs text-zinc-500 mt-1">{s.analogyCards.teacherGivesTwo.desc}</div>
            </div>
            <div className="p-4 bg-amber-500/10 rounded-lg border border-amber-500/20">
              <div className="text-3xl mb-2">🤔</div>
              <div className="text-sm font-medium text-amber-400">{s.analogyCards.studentJudges.label}</div>
              <div className="text-xs text-zinc-500 mt-1">{s.analogyCards.studentJudges.desc}</div>
            </div>
            <div className="p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-3xl mb-2">✅</div>
              <div className="text-sm font-medium text-emerald-400">{s.analogyCards.learnToScore.label}</div>
              <div className="text-xs text-zinc-500 mt-1">{s.analogyCards.learnToScore.desc}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Human Preference Collection - Interactive */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">{s.gameSectionTitle}</h3>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">{s.questionCounter.replace('{current}', String(currentExample + 1)).replace('{total}', String(preferenceExamples.length))}</span>
            <span className="text-emerald-400">{s.correctCounter.replace('{count}', String(correctCount))}</span>
          </div>
        </div>

        {/* Prompt */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-blue-400">{common.userSaidLabel}</span>
          </div>
          <p className="text-base text-zinc-200">{example.prompt}</p>
        </div>

        {/* Response Comparison */}
        <div className="grid grid-cols-2 gap-4">
          {/* Response A */}
          <div
            className={`relative rounded-lg border p-4 transition-all ${
              showResult
                ? example.preferredResponse === 'A'
                  ? 'bg-emerald-500/10 border-emerald-500/30'
                  : 'bg-red-500/5 border-red-500/20'
                : userChoice === 'A'
                  ? 'bg-blue-500/10 border-blue-500/30'
                  : 'bg-zinc-900 border-zinc-700 hover:border-zinc-600 cursor-pointer'
            }`}
            onClick={() => !showResult && handleChoice('A')}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-zinc-400">{s.responseALabel}</span>
              {showResult && (
                <span className={`text-xs px-2 py-0.5 rounded ${
                  example.preferredResponse === 'A'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/20 text-red-400'
                }`}>
                  {example.labelA}
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-400 whitespace-pre-wrap">{example.responseA}</p>
            {showResult && (
              <div className="mt-3 pt-3 border-t border-zinc-700 flex items-center gap-2">
                {example.preferredResponse === 'A' ? (
                  <><ThumbsUp className="w-4 h-4 text-emerald-400" /><span className="text-xs text-emerald-400">{s.betterAnswerLabel}</span></>
                ) : (
                  <><ThumbsDown className="w-4 h-4 text-red-400" /><span className="text-xs text-red-400">{s.notGoodEnoughLabel}</span></>
                )}
              </div>
            )}
          </div>

          {/* Response B */}
          <div
            className={`relative rounded-lg border p-4 transition-all ${
              showResult
                ? example.preferredResponse === 'B'
                  ? 'bg-emerald-500/10 border-emerald-500/30'
                  : 'bg-red-500/5 border-red-500/20'
                : userChoice === 'B'
                  ? 'bg-blue-500/10 border-blue-500/30'
                  : 'bg-zinc-900 border-zinc-700 hover:border-zinc-600 cursor-pointer'
            }`}
            onClick={() => !showResult && handleChoice('B')}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-zinc-400">{s.responseBLabel}</span>
              {showResult && (
                <span className={`text-xs px-2 py-0.5 rounded ${
                  example.preferredResponse === 'B'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/20 text-red-400'
                }`}>
                  {example.labelB}
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-400 whitespace-pre-wrap">{example.responseB}</p>
            {showResult && (
              <div className="mt-3 pt-3 border-t border-zinc-700 flex items-center gap-2">
                {example.preferredResponse === 'B' ? (
                  <><ThumbsUp className="w-4 h-4 text-emerald-400" /><span className="text-xs text-emerald-400">{s.betterAnswerLabel}</span></>
                ) : (
                  <><ThumbsDown className="w-4 h-4 text-red-400" /><span className="text-xs text-red-400">{s.notGoodEnoughLabel}</span></>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Result Explanation */}
        {showResult && (
          <div className={`rounded-lg border p-4 ${
            userChoice === example.preferredResponse
              ? 'bg-emerald-500/10 border-emerald-500/30'
              : 'bg-amber-500/10 border-amber-500/30'
          }`}>
            <div className="flex items-center gap-2 mb-2">
              {userChoice === example.preferredResponse ? (
                <>
                  <span className="text-lg">🎉</span>
                  <span className="text-sm font-medium text-emerald-400">{s.correctFeedback}</span>
                </>
              ) : (
                <>
                  <span className="text-lg">🤔</span>
                  <span className="text-sm font-medium text-amber-400">{s.differentOpinionFeedback}</span>
                </>
              )}
            </div>
            <p className="text-sm text-zinc-400">
              <strong className="text-zinc-200">{s.whyBetterTemplate.replace('{choice}', example.preferredResponse)}</strong>
              <br />
              {example.reason}
            </p>
          </div>
        )}

        {/* Next button */}
        {showResult && currentExample < preferenceExamples.length - 1 && (
          <button
            onClick={nextExample}
            className="w-full py-2.5 rounded-lg bg-amber-500/20 text-amber-400 text-sm hover:bg-amber-500/30 border border-amber-500/30 transition-all font-medium"
          >
            {s.nextQuestionButton}
          </button>
        )}

        {/* Completion message */}
        {showResult && currentExample === preferenceExamples.length - 1 && (
          <div className="p-4 rounded-lg bg-purple-500/10 border border-purple-500/30 text-center">
            <div className="text-2xl mb-2">✨</div>
            <div className="text-sm text-purple-400 font-medium">
              {s.completionTemplate.replace('{correct}', String(correctCount)).replace('{total}', String(preferenceExamples.length))}
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              {s.completionSubtext}
            </div>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{s.howItWorksTitle}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-center gap-3">
            <div className="text-center p-3 bg-blue-500/10 rounded-lg border border-blue-500/20 flex-1">
              <div className="text-2xl mb-1">📝</div>
              <div className="text-xs text-blue-400">{s.flowSteps.seeResponse}</div>
            </div>
            <ChevronRight className="w-4 h-4 text-zinc-600" />
            <div className="text-center p-3 bg-purple-500/10 rounded-lg border border-purple-500/20 flex-1">
              <div className="text-2xl mb-1">🤔</div>
              <div className="text-xs text-purple-400">{s.flowSteps.thinkAnalyze}</div>
            </div>
            <ChevronRight className="w-4 h-4 text-zinc-600" />
            <div className="text-center p-3 bg-amber-500/10 rounded-lg border border-amber-500/20 flex-1">
              <div className="text-2xl mb-1">⭐</div>
              <div className="text-xs text-amber-400">{s.flowSteps.outputScore}</div>
            </div>
          </div>
          <div className="mt-4 p-3 rounded-lg bg-zinc-800">
            <p className="text-xs text-zinc-400 text-center">
              {s.scoreExplainPrefix}<br />
              <span className="text-emerald-400">{s.scoreExampleHigh}</span>{s.scoreOrConnector}<span className="text-red-400">{s.scoreExampleLow}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Key Points */}
      <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
        <h4 className="text-sm font-medium text-amber-400 mb-2">{common.summaryTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {s.summaryPoints.map((point) => (
            <li key={point.title} className="flex items-start gap-2">
              <span className="text-amber-400">•</span>
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
          className="flex items-center gap-2 px-5 py-2.5 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 border border-amber-500/30 transition-all font-medium"
        >
          {s.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
