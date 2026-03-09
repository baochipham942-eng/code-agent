// ============================================================================
// SFTStage - 监督微调阶段
// 用通俗方式介绍「教 AI 按规矩回答」
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  FileText,
  Code,
  Play,
  Pause,
  RotateCcw,
  MessageSquare,
  User,
  Bot,
} from 'lucide-react';

interface SFTStageProps {
  onComplete: () => void;
}

// 指令数据集示例 - 用对话形式展示
const instructionExamples = [
  {
    question: '帮我把这句英文翻译成中文：Hello, how are you today?',
    answer: '你好，你今天怎么样？',
    category: '翻译任务',
  },
  {
    question: '写一首关于春天的诗',
    answer: '春风拂面暖阳照，\n桃花盛开蝶飞舞。\n万物复苏生机显，\n大地换上新衣裳。',
    category: '创作任务',
  },
  {
    question: '用简单的话解释什么是 AI',
    answer: 'AI 就像是一个会学习的程序。你给它看很多例子，它就能从中找规律，然后自己做类似的事情。就像小朋友看多了猫的照片，以后见到新的猫也能认出来！',
    category: '解释任务',
  },
  {
    question: '把「把文件给我」改写得更礼貌一点',
    answer: '请问您方便把文件发给我吗？谢谢！',
    category: '改写任务',
  },
];

// 训练前后对比 - 用更直观的例子
const beforeAfterExamples = [
  {
    question: '今天天气怎么样？',
    before: '天气是大气状态的表现，包括温度、湿度、气压等因素。气象学是研究天气的科学。在中国，中央气象台负责天气预报...',
    after: '我没有实时查看天气的能力，不过你可以打开手机的天气 App 看看！如果你告诉我你在哪个城市，我可以给你一些穿衣建议哦～',
    beforeComment: '像在背百科全书，没回答问题',
    afterComment: '承认不能做的事，还给了实用建议',
  },
];

export const SFTStage: React.FC<SFTStageProps> = ({ onComplete }) => {
  const [selectedExample, setSelectedExample] = useState(0);
  const [isTraining, setIsTraining] = useState(false);
  const [trainingStep, setTrainingStep] = useState(0);
  const [learnedCount, setLearnedCount] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 模拟训练
  const toggleTraining = () => {
    if (isTraining) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsTraining(false);
    } else {
      setIsTraining(true);
      intervalRef.current = setInterval(() => {
        setTrainingStep((prev) => {
          const newStep = prev + 1;
          setLearnedCount(Math.floor(newStep / 5));

          if (newStep >= 100) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setIsTraining(false);
            return 100;
          }
          return newStep;
        });
      }, 80);
    }
  };

  const resetTraining = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsTraining(false);
    setTrainingStep(0);
    setLearnedCount(0);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const currentExample = instructionExamples[selectedExample];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 rounded-lg border border-purple-500/20 p-4">
        <div className="flex items-start gap-3">
          <FileText className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🎓 教 AI「按规矩回答」</h3>
            <p className="text-sm text-zinc-400">
              预训练后的 AI 就像一个读了很多书的学生，虽然知识渊博，但不知道怎么好好回答问题。
              <span className="text-purple-400">监督微调</span>就是给它看很多「标准答案」，让它学会该怎么回答！
            </p>
          </div>
        </div>
      </div>

      {/* 打个比方 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">💡 打个比方</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 bg-zinc-800 rounded-lg border border-zinc-800">
              <div className="text-3xl mb-2">📚</div>
              <div className="text-sm font-medium text-zinc-400">预训练后的 AI</div>
              <div className="text-xs text-zinc-500 mt-1">读了很多书，但回答乱七八糟</div>
            </div>
            <div className="text-center p-4 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-3xl mb-2">📝</div>
              <div className="text-sm font-medium text-purple-400">看标准答案学习</div>
              <div className="text-xs text-zinc-500 mt-1">「问这个要这样答」</div>
            </div>
            <div className="text-center p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-3xl mb-2">✨</div>
              <div className="text-sm font-medium text-emerald-400">学会规矩的 AI</div>
              <div className="text-xs text-zinc-500 mt-1">知道怎么好好回答了</div>
            </div>
          </div>
        </div>
      </div>

      {/* Instruction Dataset */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">📖 「标准答案」长什么样？</h3>
        <div className="flex gap-2 mb-3">
          {instructionExamples.map((ex, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedExample(idx)}
              className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                selectedExample === idx
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : 'bg-zinc-800 text-zinc-500 border border-zinc-800 hover:border-zinc-600'
              }`}
            >
              {ex.category}
            </button>
          ))}
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4 space-y-4">
          {/* Question */}
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4 text-blue-400" />
            </div>
            <div className="flex-1">
              <div className="text-xs text-blue-400 mb-1">用户问</div>
              <p className="text-sm text-zinc-200 bg-blue-500/10 rounded-lg p-3 border border-blue-500/20">
                {currentExample.question}
              </p>
            </div>
          </div>

          {/* Answer */}
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="flex-1">
              <div className="text-xs text-emerald-400 mb-1">标准答案</div>
              <pre className="text-sm text-zinc-200 bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20 whitespace-pre-wrap">
                {currentExample.answer}
              </pre>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="text-xs text-amber-400">
            💡 就像老师批改作业一样，给 AI 看成千上万个「问题 + 标准答案」，它就学会该怎么回答了！
          </div>
        </div>
      </div>

      {/* Training Simulation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">🏋️ 让 AI 学习</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleTraining}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                isTraining
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
              }`}
            >
              {isTraining ? (
                <>
                  <Pause className="w-4 h-4" />
                  暂停学习
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  开始学习
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-zinc-500 mb-1">学习进度</div>
              <div className="text-2xl font-bold text-purple-400">{trainingStep}%</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">学会了多少题</div>
              <div className="text-2xl font-bold text-emerald-400">{learnedCount} 道</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">状态</div>
              <div className={`text-lg font-medium ${isTraining ? 'text-amber-400' : trainingStep >= 100 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                {isTraining ? '努力学习中...' : trainingStep >= 100 ? '学完啦！' : '准备好了'}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mt-4">
            <div className="h-3 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-purple-600 to-purple-400 transition-all duration-100"
                style={{ width: `${trainingStep}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Before/After Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">📊 学习前后对比</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Before SFT */}
          <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-zinc-500" />
              <span className="text-sm font-medium text-zinc-400">学习前</span>
            </div>
            <div className="mb-2 text-xs text-blue-400">问：{beforeAfterExamples[0].question}</div>
            <div className="bg-zinc-950/50 p-3 rounded text-sm text-zinc-500 whitespace-pre-wrap">
              {beforeAfterExamples[0].before}
            </div>
            <div className="mt-2 text-xs text-red-400">❌ {beforeAfterExamples[0].beforeComment}</div>
          </div>

          {/* After SFT */}
          <div className="bg-purple-500/5 rounded-lg border border-purple-500/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-purple-400">学习后</span>
            </div>
            <div className="mb-2 text-xs text-blue-400">问：{beforeAfterExamples[0].question}</div>
            <div className="bg-zinc-950/50 p-3 rounded text-sm text-emerald-400 whitespace-pre-wrap">
              {beforeAfterExamples[0].after}
            </div>
            <div className="mt-2 text-xs text-emerald-400">✓ {beforeAfterExamples[0].afterComment}</div>
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-purple-500/5 rounded-lg border border-purple-500/20 p-4">
        <h4 className="text-sm font-medium text-purple-400 mb-2">📌 小结</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          <li className="flex items-start gap-2">
            <span className="text-purple-400">•</span>
            <span><strong className="text-zinc-400">标准答案的质量很重要</strong>：老师教得好，学生才能学得好</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-purple-400">•</span>
            <span><strong className="text-zinc-400">要有足够多的例子</strong>：做一道题学不会，得多做才行</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-purple-400">•</span>
            <span><strong className="text-zinc-400">这只是第一步</strong>：学会「格式」，但还没学会什么是「好」</span>
          </li>
        </ul>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'SFT', zh: '监督微调', desc: 'Supervised Fine-Tuning，用标注好的问答对训练模型' },
            { en: 'Instruction Tuning', zh: '指令微调', desc: '教模型理解和遵循人类指令的训练方式' },
            { en: 'Instruction Dataset', zh: '指令数据集', desc: '包含问题和标准答案的训练数据' },
            { en: 'Demonstration', zh: '示范', desc: '给模型展示正确回答的例子，作为学习样本' },
          ].map((term) => (
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
          className="flex items-center gap-2 px-5 py-2.5 bg-purple-500/20 text-purple-400 rounded-lg hover:bg-purple-500/30 border border-purple-500/30 transition-all font-medium"
        >
          下一步：教 AI 分辨好坏
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
