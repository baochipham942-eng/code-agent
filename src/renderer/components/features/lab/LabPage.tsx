// ============================================================================
// LabPage - 实验室主页面
// 模型训练学习平台入口
// ============================================================================

import React, { useState } from 'react';
import { X, FlaskConical, Sparkles, Lock, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { GPT1Lab } from './gpt1/GPT1Lab';
import { NanoGPTLab } from './nanogpt/NanoGPTLab';
import { AlignmentLab } from './alignment/AlignmentLab';
import { LLaMAFactoryLab } from './llamafactory/LLaMAFactoryLab';

// 实验类型
type LabType = 'home' | 'gpt1' | 'nanogpt' | 'alignment' | 'llamafactory';

// 实验卡片配置
interface LabCard {
  id: LabType;
  title: string;
  subtitle: string;
  description: string;
  level: string;
  levelStars: number;
  params: string;
  status: 'available' | 'coming_soon' | 'locked';
  gradient: string;
  iconBg: string;
}

const labCards: LabCard[] = [
  {
    id: 'gpt1',
    title: '教 AI 学说话',
    subtitle: '从零开始，亲手训练一个会聊天的 AI',
    description: '就像教小孩说话一样：先给它听对话、教它认字、建立语言能力、反复练习，最后它就能自己说话了。',
    level: '入门级',
    levelStars: 1,
    params: '约 1100 万个"脑细胞"',
    status: 'available',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    iconBg: 'bg-emerald-500/20',
  },
  {
    id: 'nanogpt',
    title: '让 AI 读更多书',
    subtitle: '训练一个能写莎士比亚风格文章的 AI',
    description: '如果说第一个实验是教 AI 说日常对话，这个实验就是让它读大量书籍，学会更复杂的写作风格。',
    level: '进阶级',
    levelStars: 2,
    params: '约 1000 万~1.2 亿个"脑细胞"',
    status: 'available',
    gradient: 'from-blue-500/20 to-indigo-500/20',
    iconBg: 'bg-blue-500/20',
  },
  {
    id: 'alignment',
    title: '让 AI 学会听话',
    subtitle: '教 AI 按照人类的要求来回答',
    description: 'AI 学会说话后，还要学会"听指令"。这个实验教你如何让 AI 更好地理解和执行人类的要求。',
    level: '高级',
    levelStars: 3,
    params: '在已训练模型上调整',
    status: 'available',
    gradient: 'from-purple-500/20 to-pink-500/20',
    iconBg: 'bg-purple-500/20',
  },
  {
    id: 'llamafactory',
    title: '让 AI 更聪明',
    subtitle: '用专业工具微调大模型',
    description: '学会使用 LLaMA Factory 工具，掌握 SFT、DPO 等主流微调技术，让 AI 在特定任务上表现更好。',
    level: '高级',
    levelStars: 3,
    params: '概念演示模式',
    status: 'available',
    gradient: 'from-orange-500/20 to-amber-500/20',
    iconBg: 'bg-orange-500/20',
  },
];

export const LabPage: React.FC = () => {
  const { setShowLab } = useAppStore();
  const [currentLab, setCurrentLab] = useState<LabType>('home');

  // 渲染主页卡片选择
  const renderHome = () => (
    <div className="flex-1 overflow-y-auto p-8">
      {/* Hero Section */}
      <div className="text-center mb-12">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 mb-4">
          <FlaskConical className="w-8 h-8 text-emerald-400" />
        </div>
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">AI 学习实验室</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          不需要任何编程基础，通过动手实验，亲眼看看 AI 是怎么一步步学会"说话"的
        </p>
      </div>

      {/* Lab Cards - 4 列布局 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 max-w-6xl mx-auto">
        {labCards.map((card, index) => (
          <LabCardComponent
            key={`${card.id}-${index}`}
            card={card}
            onClick={() => {
              if (card.status === 'available') {
                setCurrentLab(card.id);
              }
            }}
          />
        ))}
      </div>

      {/* Learning Path */}
      <div className="mt-12 max-w-3xl mx-auto">
        <h2 className="text-lg font-semibold text-zinc-200 mb-4 text-center">推荐学习顺序</h2>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-emerald-400 text-sm font-medium">① 学说话</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <span className="text-zinc-500 text-sm">② 读更多书</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <span className="text-zinc-500 text-sm">③ 学会听话</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <span className="text-zinc-500 text-sm">④ 微调进阶</span>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mt-3 text-center">
          建议从第一个实验开始，每个实验大约需要 15-30 分钟
        </p>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0d0d0f]">
      {/* Header - pl-20 为 macOS 窗口控制按钮留出空间 */}
      <div className="flex items-center justify-between pl-20 pr-4 py-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-emerald-400" />
          <h1 className="text-lg font-semibold text-zinc-100">
            {currentLab === 'home'
              ? '实验室'
              : currentLab === 'gpt1'
                ? '教 AI 学说话'
                : currentLab === 'nanogpt'
                  ? '让 AI 读更多书'
                  : currentLab === 'alignment'
                    ? '让 AI 学会听话'
                    : '让 AI 更聪明'}
          </h1>
        </div>
        {/* 关闭按钮 - 增大热区 */}
        <button
          onClick={() => setShowLab(false)}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      {currentLab === 'home' && renderHome()}
      {currentLab === 'gpt1' && <GPT1Lab />}
      {currentLab === 'nanogpt' && <NanoGPTLab />}
      {currentLab === 'alignment' && <AlignmentLab />}
      {currentLab === 'llamafactory' && <LLaMAFactoryLab />}
    </div>
  );
};

// 实验卡片组件
const LabCardComponent: React.FC<{
  card: LabCard;
  onClick: () => void;
}> = ({ card, onClick }) => {
  const isAvailable = card.status === 'available';
  const isComingSoon = card.status === 'coming_soon';
  const isLocked = card.status === 'locked';

  return (
    <button
      onClick={onClick}
      disabled={!isAvailable}
      className={`
        relative p-6 rounded-2xl text-left transition-all duration-300
        bg-gradient-to-br ${card.gradient}
        border border-zinc-800/50
        ${isAvailable ? 'hover:border-zinc-700 hover:scale-[1.02] cursor-pointer' : 'cursor-not-allowed opacity-60'}
      `}
    >
      {/* Status Badge */}
      {isComingSoon && (
        <div className="absolute top-4 right-4 px-2 py-1 rounded-full bg-amber-500/20 border border-amber-500/30">
          <span className="text-xs text-amber-400">即将开放</span>
        </div>
      )}
      {isLocked && (
        <div className="absolute top-4 right-4">
          <Lock className="w-4 h-4 text-zinc-600" />
        </div>
      )}

      {/* Icon */}
      <div className={`w-12 h-12 rounded-xl ${card.iconBg} border border-white/10 flex items-center justify-center mb-4`}>
        <Sparkles className="w-6 h-6 text-white/80" />
      </div>

      {/* Title */}
      <h3 className="text-lg font-semibold text-zinc-100 mb-1">{card.title}</h3>
      <p className="text-sm text-zinc-400 mb-3">{card.subtitle}</p>

      {/* Description */}
      <p className="text-xs text-zinc-500 mb-4 line-clamp-2">{card.description}</p>

      {/* Meta */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <span
              key={i}
              className={`text-xs ${i < card.levelStars ? 'text-amber-400' : 'text-zinc-700'}`}
            >
              ★
            </span>
          ))}
          <span className="text-xs text-zinc-500 ml-1">{card.level}</span>
        </div>
        <span className="text-xs text-zinc-600">{card.params}</span>
      </div>

      {/* Action hint */}
      {isAvailable && (
        <div className="mt-4 pt-4 border-t border-zinc-800/50">
          <span className="text-sm text-emerald-400 flex items-center gap-1">
            开始学习 <ChevronRight className="w-4 h-4" />
          </span>
        </div>
      )}
    </button>
  );
};
