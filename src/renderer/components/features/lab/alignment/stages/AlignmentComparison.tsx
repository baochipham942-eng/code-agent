// ============================================================================
// AlignmentComparison - 对齐效果对比阶段
// 展示 Base → SFT → RLHF 各阶段模型输出对比
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronLeft,
  Layers,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Sparkles,
  MessageSquare,
  Bot,
} from 'lucide-react';

interface AlignmentComparisonProps {
  onBack: () => void;
}

// 对比示例数据
const comparisonExamples = [
  {
    prompt: '如何做一道简单的番茄炒蛋？',
    responses: {
      base: '番茄炒蛋是一道常见的中国菜，需要番茄和鸡蛋。番茄富含维生素C，鸡蛋含有蛋白质。中国人经常吃这道菜，它很受欢迎。番茄的英文是tomato，鸡蛋的英文是egg。这道菜在全国各地都很流行...',
      sft: `番茄炒蛋的做法：

1. 准备材料：2个番茄、3个鸡蛋、适量盐和糖
2. 鸡蛋打散，加少许盐
3. 番茄切块
4. 热锅下油，炒熟鸡蛋盛出
5. 另起油锅，炒番茄至出汁
6. 加入鸡蛋翻炒
7. 加盐和少许糖调味即可`,
      rlhf: `番茄炒蛋是一道经典的家常菜，制作简单又美味！这是详细步骤：

**材料准备**
- 番茄 2个（选熟透的，更出汁）
- 鸡蛋 3个
- 葱花适量

**步骤**
1. 鸡蛋打散，加一点点盐，搅拌均匀
2. 番茄切成小块，大小随个人喜好
3. 锅热后倒油，油温七成热时倒入蛋液
4. 蛋液稍凝固就快速划散，盛出备用
5. 锅中再加少许油，下番茄块翻炒
6. 番茄软烂出汁后，加入炒好的鸡蛋
7. 加盐调味，喜欢甜口可加一点糖
8. 撒上葱花，出锅！

**小贴士**：鸡蛋不要炒太老，嫩一点更好吃 😊`,
    },
    analysis: {
      base: ['❌ 跑题，没有实际做法', '❌ 输出杂乱无章', '❌ 不像在回答问题'],
      sft: ['✓ 有清晰的步骤', '✓ 信息准确完整', '△ 比较机械，缺少温度'],
      rlhf: ['✓ 结构清晰美观', '✓ 有实用小贴士', '✓ 语气友好自然'],
    },
  },
  {
    prompt: '我今天心情不好，你能安慰我吗？',
    responses: {
      base: '心情不好是一种情绪状态。情绪受到多种因素影响，包括生理、心理和环境因素。研究表明，运动可以改善心情。多巴胺是一种与快乐相关的神经递质。睡眠也会影响情绪...',
      sft: '很抱歉听到你心情不好。以下是一些可能有帮助的建议：\n1. 深呼吸，尝试放松\n2. 和朋友聊聊天\n3. 做一些你喜欢的事情\n4. 适当运动\n5. 保持充足的睡眠\n\n希望你能感觉好一些。',
      rlhf: '听到你心情不好，我很心疼 💙\n\n有时候我们就是会有这样的时刻，这很正常。你愿意告诉我发生了什么吗？\n\n如果不想说也没关系，我陪着你。也许你可以：\n- 给自己泡杯热茶，暖暖心\n- 听听喜欢的音乐\n- 或者就躺一会儿，什么都不想\n\n记住，低落的情绪会过去的。你已经很棒了，要对自己温柔一点 🌟',
    },
    analysis: {
      base: ['❌ 完全没有共情', '❌ 像在讲科普', '❌ 让人更难受'],
      sft: ['✓ 提供了建议', '✓ 表达了关心', '△ 有点模板化'],
      rlhf: ['✓ 有温度和共情', '✓ 尊重用户感受', '✓ 自然贴心'],
    },
  },
  {
    prompt: '写一个 Python 函数判断回文',
    responses: {
      base: `def palindrome():
    # 回文是指正读反读都一样的字符串
    # 比如 "aba", "12321"
    # Python 是一种编程语言
    pass`,
      sft: `def is_palindrome(s: str) -> bool:
    """判断字符串是否为回文"""
    s = s.lower()
    return s == s[::-1]`,
      rlhf: `def is_palindrome(s: str) -> bool:
    """
    判断字符串是否为回文。

    Args:
        s: 待检测的字符串

    Returns:
        如果是回文返回 True，否则返回 False

    Examples:
        >>> is_palindrome("aba")
        True
        >>> is_palindrome("hello")
        False
    """
    # 统一转小写，忽略大小写差异
    s = s.lower()
    # 双指针从两端向中间比较
    left, right = 0, len(s) - 1
    while left < right:
        if s[left] != s[right]:
            return False
        left += 1
        right -= 1
    return True`,
    },
    analysis: {
      base: ['❌ 函数没有实现', '❌ 只有注释', '❌ 无法使用'],
      sft: ['✓ 代码正确简洁', '✓ 有类型注解', '△ 缺少示例'],
      rlhf: ['✓ 完整的文档', '✓ 有使用示例', '✓ 代码可读性强'],
    },
  },
];

export const AlignmentComparison: React.FC<AlignmentComparisonProps> = ({ onBack }) => {
  const [selectedExample, setSelectedExample] = useState(0);
  const example = comparisonExamples[selectedExample];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-pink-500/10 to-rose-500/10 rounded-lg border border-pink-500/20 p-4">
        <div className="flex items-start gap-3">
          <Layers className="w-5 h-5 text-pink-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">对齐效果对比</h3>
            <p className="text-xs text-zinc-400">
              比较同一个 prompt 在不同训练阶段的模型输出。从 Base（预训练）→ SFT（监督微调）→ RLHF（强化学习），
              观察模型如何逐步学会遵循指令、提供有帮助的回答。
            </p>
          </div>
        </div>
      </div>

      {/* Example Selector */}
      <div className="flex gap-2">
        {comparisonExamples.map((ex, idx) => (
          <button
            key={idx}
            onClick={() => setSelectedExample(idx)}
            className={`px-4 py-2 rounded-lg text-sm transition-all ${
              selectedExample === idx
                ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                : 'bg-zinc-800/30 text-zinc-500 border border-zinc-700/30 hover:border-zinc-600'
            }`}
          >
            示例 {idx + 1}
          </button>
        ))}
      </div>

      {/* Prompt */}
      <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-4 h-4 text-zinc-400" />
          <span className="text-xs text-zinc-500">用户输入</span>
        </div>
        <p className="text-sm text-zinc-200">{example.prompt}</p>
      </div>

      {/* Three Stage Comparison */}
      <div className="grid grid-cols-3 gap-4">
        {/* Base Model */}
        <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bot className="w-4 h-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-400">Base Model</span>
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-700/50 text-zinc-500">预训练</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 max-h-48 overflow-y-auto">
            <pre className="text-xs text-zinc-500 whitespace-pre-wrap font-mono">{example.responses.base}</pre>
          </div>
          <div className="space-y-1">
            {example.analysis.base.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs">
                {item.startsWith('❌') ? (
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                ) : item.startsWith('✓') ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                ) : (
                  <span className="w-3 text-center text-amber-400">△</span>
                )}
                <span className="text-zinc-500">{item.replace(/^[❌✓△]\s*/, '')}</span>
              </div>
            ))}
          </div>
        </div>

        {/* SFT Model */}
        <div className="bg-purple-500/5 rounded-lg border border-purple-500/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bot className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-purple-400">SFT Model</span>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">监督微调</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 max-h-48 overflow-y-auto">
            <pre className="text-xs text-purple-300/80 whitespace-pre-wrap font-mono">{example.responses.sft}</pre>
          </div>
          <div className="space-y-1">
            {example.analysis.sft.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs">
                {item.startsWith('✓') ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                ) : item.startsWith('△') ? (
                  <span className="w-3 text-center text-amber-400">△</span>
                ) : (
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                )}
                <span className="text-zinc-400">{item.replace(/^[❌✓△]\s*/, '')}</span>
              </div>
            ))}
          </div>
        </div>

        {/* RLHF Model */}
        <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bot className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-medium text-emerald-400">RLHF Model</span>
            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">强化学习</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 max-h-48 overflow-y-auto">
            <pre className="text-xs text-emerald-300/80 whitespace-pre-wrap font-mono">{example.responses.rlhf}</pre>
          </div>
          <div className="space-y-1">
            {example.analysis.rlhf.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs">
                {item.startsWith('✓') ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                ) : item.startsWith('△') ? (
                  <span className="w-3 text-center text-amber-400">△</span>
                ) : (
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                )}
                <span className="text-zinc-300">{item.replace(/^[❌✓△]\s*/, '')}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Evolution Flow */}
      <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
        <h4 className="text-sm font-medium text-zinc-300 mb-3">能力演进</h4>
        <div className="flex items-center justify-center gap-4">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-zinc-800/50 border border-zinc-700 flex items-center justify-center mb-2">
              <span className="text-2xl">📚</span>
            </div>
            <div className="text-xs text-zinc-500">预训练</div>
            <div className="text-[10px] text-zinc-600">语言能力</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600" />
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center mb-2">
              <span className="text-2xl">📝</span>
            </div>
            <div className="text-xs text-purple-400">SFT</div>
            <div className="text-[10px] text-zinc-600">指令遵循</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600" />
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-2">
              <span className="text-2xl">✨</span>
            </div>
            <div className="text-xs text-emerald-400">RLHF</div>
            <div className="text-[10px] text-zinc-600">人类偏好</div>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="bg-pink-500/5 rounded-lg border border-pink-500/20 p-4">
        <h4 className="text-sm font-medium text-pink-400 mb-2">总结</h4>
        <ul className="space-y-1 text-xs text-zinc-400">
          <li>
            • <strong className="text-zinc-300">Base Model</strong>：有语言能力，但不知道如何有帮助地回答
          </li>
          <li>
            • <strong className="text-zinc-300">SFT Model</strong>：学会了遵循指令，回答格式正确
          </li>
          <li>
            • <strong className="text-zinc-300">RLHF Model</strong>：学会了人类偏好，回答更自然、更有帮助
          </li>
          <li className="pt-2 border-t border-zinc-800/50 mt-2">
            <Sparkles className="w-3 h-3 inline-block mr-1 text-pink-400" />
            对齐（Alignment）不是让模型更「聪明」，而是让它学会如何把能力用在帮助人类上
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
          上一步：PPO 训练
        </button>
        <div className="flex items-center gap-2 px-4 py-2 bg-pink-500/10 text-pink-400 rounded-lg border border-pink-500/20">
          <CheckCircle2 className="w-4 h-4" />
          恭喜完成 RLHF 学习！
        </div>
      </div>
    </div>
  );
};
