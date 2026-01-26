// ============================================================================
// RewardModelStage - 奖励模型阶段
// 展示人类偏好数据收集和奖励模型训练概念
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

interface RewardModelStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 偏好对比数据
const preferenceExamples = [
  {
    prompt: '如何学习编程？',
    responseA: '去学就行了，网上有很多资源。',
    responseB:
      '我建议从以下几个步骤开始：\n1. 选择一门入门语言（如 Python）\n2. 通过在线课程学习基础语法\n3. 做小项目巩固所学\n4. 加入编程社区交流\n5. 持续练习和阅读优秀代码',
    preferredResponse: 'B',
    reason: '回答 B 更详细、结构化，提供了可操作的建议',
  },
  {
    prompt: '解释什么是递归',
    responseA:
      '递归就是函数调用自己。比如计算阶乘：n! = n × (n-1)!，其中 0! = 1。递归需要基本情况（停止条件）和递归情况（自我调用）两个要素。',
    responseB: '递归？就是套娃呗，一层套一层。',
    preferredResponse: 'A',
    reason: '回答 A 专业准确，包含示例和关键概念',
  },
  {
    prompt: '写一个冒泡排序',
    responseA: `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n-i-1):
            if arr[j] > arr[j+1]:
                arr[j], arr[j+1] = arr[j+1], arr[j]
    return arr`,
    responseB: `def bubble_sort(arr):
    """
    冒泡排序实现
    时间复杂度: O(n²)
    空间复杂度: O(1)
    """
    n = len(arr)
    for i in range(n):
        swapped = False
        for j in range(0, n-i-1):
            if arr[j] > arr[j+1]:
                arr[j], arr[j+1] = arr[j+1], arr[j]
                swapped = True
        # 优化：如果没有交换，说明已排序
        if not swapped:
            break
    return arr`,
    preferredResponse: 'B',
    reason: '回答 B 包含文档、复杂度分析和优化',
  },
];

// 奖励模型架构可视化数据
const rewardModelLayers = [
  { name: 'Input', desc: 'Prompt + Response 拼接', color: 'bg-blue-500/20', textColor: 'text-blue-400' },
  { name: 'Transformer', desc: '共享预训练权重', color: 'bg-purple-500/20', textColor: 'text-purple-400' },
  { name: 'Pooling', desc: '取最后一个 token', color: 'bg-amber-500/20', textColor: 'text-amber-400' },
  { name: 'Linear', desc: '投影到标量', color: 'bg-emerald-500/20', textColor: 'text-emerald-400' },
  { name: 'Reward', desc: '输出奖励分数', color: 'bg-pink-500/20', textColor: 'text-pink-400' },
];

export const RewardModelStage: React.FC<RewardModelStageProps> = ({ onComplete, onBack }) => {
  const [currentExample, setCurrentExample] = useState(0);
  const [userChoice, setUserChoice] = useState<'A' | 'B' | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [animatingScore, setAnimatingScore] = useState(false);
  const [scoreA, setScoreA] = useState(0);
  const [scoreB, setScoreB] = useState(0);

  const example = preferenceExamples[currentExample];

  // 处理用户选择
  const handleChoice = (choice: 'A' | 'B') => {
    setUserChoice(choice);
    setShowResult(true);
    setAnimatingScore(true);

    // 模拟奖励分数动画
    const targetA = choice === 'A' ? 0.85 : 0.35;
    const targetB = choice === 'B' ? 0.85 : 0.35;

    let step = 0;
    const animate = () => {
      step++;
      setScoreA(Math.min(targetA, (step / 20) * targetA));
      setScoreB(Math.min(targetB, (step / 20) * targetB));
      if (step < 20) {
        requestAnimationFrame(animate);
      } else {
        setAnimatingScore(false);
      }
    };
    animate();
  };

  // 下一个示例
  const nextExample = () => {
    if (currentExample < preferenceExamples.length - 1) {
      setCurrentExample((prev) => prev + 1);
      setUserChoice(null);
      setShowResult(false);
      setScoreA(0);
      setScoreB(0);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-lg border border-amber-500/20 p-4">
        <div className="flex items-start gap-3">
          <Trophy className="w-5 h-5 text-amber-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">奖励模型 (Reward Model)</h3>
            <p className="text-xs text-zinc-400">
              奖励模型是 RLHF 的核心组件，它学习人类对回答质量的偏好。通过对比两个回答，
              人类标注员选择更好的那个，这些偏好数据用于训练奖励模型，为 PPO 提供信号。
            </p>
          </div>
        </div>
      </div>

      {/* Human Preference Collection */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">人类偏好收集</h3>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>示例 {currentExample + 1} / {preferenceExamples.length}</span>
          </div>
        </div>

        {/* Prompt */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-zinc-400" />
            <span className="text-xs text-zinc-500">用户提问</span>
          </div>
          <p className="text-sm text-zinc-200">{example.prompt}</p>
        </div>

        {/* Response Comparison */}
        <div className="grid grid-cols-2 gap-4">
          {/* Response A */}
          <div
            className={`relative rounded-lg border p-4 transition-all cursor-pointer ${
              userChoice === 'A'
                ? 'bg-blue-500/10 border-blue-500/30'
                : 'bg-zinc-900/50 border-zinc-800/50 hover:border-zinc-700'
            }`}
            onClick={() => !showResult && handleChoice('A')}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400">回答 A</span>
              {showResult && (
                <div className="flex items-center gap-1">
                  {example.preferredResponse === 'A' ? (
                    <ThumbsUp className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <ThumbsDown className="w-4 h-4 text-zinc-600" />
                  )}
                </div>
              )}
            </div>
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{example.responseA}</pre>
            {showResult && (
              <div className="mt-3 pt-3 border-t border-zinc-800/50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-zinc-500">奖励分数</span>
                  <span className="text-sm font-mono text-blue-400">{scoreA.toFixed(2)}</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${scoreA * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Response B */}
          <div
            className={`relative rounded-lg border p-4 transition-all cursor-pointer ${
              userChoice === 'B'
                ? 'bg-emerald-500/10 border-emerald-500/30'
                : 'bg-zinc-900/50 border-zinc-800/50 hover:border-zinc-700'
            }`}
            onClick={() => !showResult && handleChoice('B')}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400">回答 B</span>
              {showResult && (
                <div className="flex items-center gap-1">
                  {example.preferredResponse === 'B' ? (
                    <ThumbsUp className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <ThumbsDown className="w-4 h-4 text-zinc-600" />
                  )}
                </div>
              )}
            </div>
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{example.responseB}</pre>
            {showResult && (
              <div className="mt-3 pt-3 border-t border-zinc-800/50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-zinc-500">奖励分数</span>
                  <span className="text-sm font-mono text-emerald-400">{scoreB.toFixed(2)}</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${scoreB * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Result Explanation */}
        {showResult && (
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Scale className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-zinc-300">
                {userChoice === example.preferredResponse ? '✓ 你的选择与人类标注一致！' : '你的选择与人类标注不同'}
              </span>
            </div>
            <p className="text-xs text-zinc-400">
              <strong className="text-zinc-300">标注理由：</strong>
              {example.reason}
            </p>
          </div>
        )}

        {/* Next button */}
        {showResult && currentExample < preferenceExamples.length - 1 && (
          <button
            onClick={nextExample}
            className="w-full py-2 rounded-lg bg-amber-500/10 text-amber-400 text-sm hover:bg-amber-500/20 border border-amber-500/20 transition-all"
          >
            下一个示例
          </button>
        )}
      </div>

      {/* Reward Model Architecture */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">奖励模型架构</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center justify-center gap-2">
            {rewardModelLayers.map((layer, idx) => (
              <React.Fragment key={layer.name}>
                <div className={`px-3 py-2 rounded-lg ${layer.color} border border-white/10`}>
                  <div className={`text-xs font-medium ${layer.textColor}`}>{layer.name}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{layer.desc}</div>
                </div>
                {idx < rewardModelLayers.length - 1 && (
                  <ChevronRight className="w-4 h-4 text-zinc-600" />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Training Loss */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">训练损失函数</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-3 mb-3">
            <BarChart3 className="w-4 h-4 text-purple-400" />
            <span className="text-sm text-zinc-300">Bradley-Terry 模型</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg font-mono text-sm">
            <div className="text-purple-400">
              L(θ) = -E<sub>(x,y<sub>w</sub>,y<sub>l</sub>)</sub> [log σ(r<sub>θ</sub>(x,y<sub>w</sub>) - r<sub>θ</sub>(x,y<sub>l</sub>))]
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-zinc-500">
            <div>
              <span className="text-zinc-400">y<sub>w</sub></span>: 偏好回答
            </div>
            <div>
              <span className="text-zinc-400">y<sub>l</sub></span>: 被拒绝回答
            </div>
            <div>
              <span className="text-zinc-400">r<sub>θ</sub></span>: 奖励分数
            </div>
          </div>
        </div>
      </div>

      {/* Key Points */}
      <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
        <h4 className="text-sm font-medium text-amber-400 mb-2">奖励模型要点</h4>
        <ul className="space-y-1 text-xs text-zinc-400">
          <li>
            • <strong className="text-zinc-300">偏好对比</strong>：不是打分，而是选择哪个更好
          </li>
          <li>
            • <strong className="text-zinc-300">相对评估</strong>：学习的是相对偏好，不是绝对质量
          </li>
          <li>
            • <strong className="text-zinc-300">共享骨干</strong>：通常使用 SFT 模型初始化
          </li>
          <li>
            • <strong className="text-zinc-300">标量输出</strong>：为每个 (prompt, response) 输出一个分数
          </li>
        </ul>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步：SFT
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 border border-amber-500/30 transition-all"
        >
          下一步：PPO 训练
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
