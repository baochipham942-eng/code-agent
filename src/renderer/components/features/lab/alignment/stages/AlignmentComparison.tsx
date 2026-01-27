// ============================================================================
// AlignmentComparison - 对齐效果对比阶段
// 用直观方式展示 AI 的进步
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

// 对比示例数据 - 更贴近日常的例子
const comparisonExamples = [
  {
    prompt: '如何做一道简单的番茄炒蛋？',
    category: '生活问答',
    responses: {
      base: '番茄炒蛋是一道常见的中国菜，需要番茄和鸡蛋。番茄富含维生素C，鸡蛋含有蛋白质。中国人经常吃这道菜，它很受欢迎。番茄的英文是tomato...',
      sft: '番茄炒蛋的做法：\n1. 准备：2个番茄、3个鸡蛋\n2. 鸡蛋打散加盐\n3. 番茄切块\n4. 先炒蛋盛出\n5. 炒番茄，加蛋翻炒\n6. 加盐调味',
      rlhf: '番茄炒蛋超简单！\n\n材料：番茄2个、鸡蛋3个\n\n步骤：\n1. 蛋打散加点盐\n2. 番茄切块（熟的更好吃）\n3. 油热炒蛋，嫩一点盛出\n4. 炒番茄出汁，放蛋\n5. 加盐，甜口加糖\n\n小技巧：蛋不要炒老，嫩嫩的最好！',
    },
    comments: {
      base: '跑题了，没说怎么做',
      sft: '步骤清楚，但有点干巴巴',
      rlhf: '既实用又贴心，还有小技巧',
    },
  },
  {
    prompt: '我今天心情不好',
    category: '情感交流',
    responses: {
      base: '心情不好是一种情绪状态。情绪受到多种因素影响，包括生理、心理和环境因素。研究表明，运动可以改善心情...',
      sft: '很抱歉听到你心情不好。建议：\n1. 深呼吸放松\n2. 和朋友聊天\n3. 做喜欢的事\n4. 适当运动\n5. 保持睡眠\n\n希望你能好起来。',
      rlhf: '抱抱你 💙\n\n有时候就是会有这样的时刻，很正常。想说说发生什么了吗？\n\n不想说也没关系。也许可以：\n- 泡杯热茶暖暖心\n- 听听喜欢的歌\n- 或者就躺一会儿\n\n低落会过去的，对自己温柔一点 🌟',
    },
    comments: {
      base: '像在讲科普，冷冰冰的',
      sft: '给了建议，但缺少温度',
      rlhf: '有温度、有共情、很贴心',
    },
  },
  {
    prompt: '推荐一部电影',
    category: '推荐请求',
    responses: {
      base: '电影是一种艺术形式。电影产业起源于19世纪末。好莱坞是美国电影工业的中心。电影可以分为剧情片、喜剧片、动作片等类型...',
      sft: '推荐《肖申克的救赎》\n- 豆瓣评分：9.7\n- 类型：剧情\n- 讲述囚犯安迪的故事\n- 关于希望和自由',
      rlhf: '你喜欢什么类型呀？\n\n治愈系 → 《千与千寻》\n烧脑悬疑 → 《盗梦空间》\n轻松搞笑 → 《功夫》\n感动催泪 → 《寻梦环游记》\n\n告诉我你现在的心情，我帮你挑一个最适合的！',
    },
    comments: {
      base: '完全没有推荐电影',
      sft: '推荐了，但没考虑我的喜好',
      rlhf: '先问喜好再推荐，很周到',
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
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🎉 看看 AI 的进步！</h3>
            <p className="text-sm text-zinc-400">
              同样一个问题，不同阶段的 AI 回答有什么不同？
              从「只会说话」到「会好好回答」，看看 AI 是怎么一步步变聪明的！
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
            {ex.category}
          </button>
        ))}
      </div>

      {/* Prompt */}
      <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-4 h-4 text-blue-400" />
          <span className="text-sm text-blue-400">用户说：</span>
        </div>
        <p className="text-base text-zinc-200">{example.prompt}</p>
      </div>

      {/* Three Stage Comparison */}
      <div className="grid grid-cols-3 gap-4">
        {/* Base Model */}
        <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-lg">📚</div>
              <span className="text-sm font-medium text-zinc-400">刚读完书的 AI</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-700/50 text-zinc-500">第一阶段</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 min-h-[120px]">
            <p className="text-sm text-zinc-500 whitespace-pre-wrap">{example.responses.base}</p>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
            <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <span className="text-xs text-red-400">{example.comments.base}</span>
          </div>
        </div>

        {/* SFT Model */}
        <div className="bg-purple-500/5 rounded-lg border border-purple-500/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-lg">📝</div>
              <span className="text-sm font-medium text-purple-400">学了回答方式的 AI</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">第二阶段</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 min-h-[120px]">
            <p className="text-sm text-purple-300/80 whitespace-pre-wrap">{example.responses.sft}</p>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/20">
            <span className="w-4 text-center text-amber-400">△</span>
            <span className="text-xs text-amber-400">{example.comments.sft}</span>
          </div>
        </div>

        {/* RLHF Model */}
        <div className="bg-emerald-500/5 rounded-lg border border-emerald-500/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="text-lg">✨</div>
              <span className="text-sm font-medium text-emerald-400">学会「好回答」的 AI</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">第三阶段</span>
          </div>
          <div className="bg-zinc-950/50 p-3 rounded-lg mb-3 min-h-[120px]">
            <p className="text-sm text-emerald-300/80 whitespace-pre-wrap">{example.responses.rlhf}</p>
          </div>
          <div className="flex items-center gap-2 p-2 rounded bg-emerald-500/10 border border-emerald-500/20">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span className="text-xs text-emerald-400">{example.comments.rlhf}</span>
          </div>
        </div>
      </div>

      {/* Evolution Flow */}
      <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
        <h4 className="text-sm font-medium text-zinc-300 mb-4 text-center">🌱 AI 的成长之路</h4>
        <div className="flex items-center justify-center gap-2">
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-zinc-800/50 border border-zinc-700 flex items-center justify-center mb-2">
              <span className="text-2xl">📚</span>
            </div>
            <div className="text-sm text-zinc-400 font-medium">读书</div>
            <div className="text-xs text-zinc-600">会说话了</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600 flex-shrink-0" />
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center mb-2">
              <span className="text-2xl">📝</span>
            </div>
            <div className="text-sm text-purple-400 font-medium">学回答</div>
            <div className="text-xs text-zinc-600">知道格式了</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600 flex-shrink-0" />
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-2">
              <span className="text-2xl">⭐</span>
            </div>
            <div className="text-sm text-amber-400 font-medium">学打分</div>
            <div className="text-xs text-zinc-600">知道好坏了</div>
          </div>
          <ArrowRight className="w-6 h-6 text-zinc-600 flex-shrink-0" />
          <div className="text-center flex-1 max-w-[140px]">
            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-2">
              <span className="text-2xl">✨</span>
            </div>
            <div className="text-sm text-emerald-400 font-medium">练习进步</div>
            <div className="text-xs text-zinc-600">越来越好！</div>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="bg-pink-500/5 rounded-lg border border-pink-500/20 p-4">
        <h4 className="text-sm font-medium text-pink-400 mb-3">📌 今天学到了什么？</h4>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="p-3 bg-zinc-800/30 rounded-lg text-center">
            <div className="text-2xl mb-1">🎓</div>
            <div className="text-xs text-zinc-400">SFT：教 AI 按格式回答</div>
          </div>
          <div className="p-3 bg-zinc-800/30 rounded-lg text-center">
            <div className="text-2xl mb-1">⚖️</div>
            <div className="text-xs text-zinc-400">奖励模型：教 AI 分辨好坏</div>
          </div>
          <div className="p-3 bg-zinc-800/30 rounded-lg text-center">
            <div className="text-2xl mb-1">🚀</div>
            <div className="text-xs text-zinc-400">PPO：让 AI 越来越好</div>
          </div>
        </div>
        <div className="p-3 rounded-lg bg-pink-500/10 border border-pink-500/20">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-pink-400" />
            <p className="text-sm text-zinc-300">
              <strong className="text-pink-400">「对齐」</strong>不是让 AI 更聪明，
              而是让它学会<strong className="text-emerald-400">怎样把能力用在帮助人上</strong>！
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <div className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-pink-500/20 to-emerald-500/20 text-pink-400 rounded-lg border border-pink-500/30">
          <CheckCircle2 className="w-4 h-4" />
          <span className="font-medium">恭喜你完成了 RLHF 学习！🎉</span>
        </div>
      </div>
    </div>
  );
};
