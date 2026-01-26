// ============================================================================
// LabPage - 实验室主页面
// 模型训练学习平台入口
// ============================================================================

import React, { useState } from 'react';
import { X, FlaskConical, Sparkles, Lock, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { GPT1Lab } from './gpt1/GPT1Lab';
import { NanoGPTLab } from './nanogpt/NanoGPTLab';

// 实验类型
type LabType = 'home' | 'gpt1' | 'nanogpt';

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
    title: 'GPT-1 对话模型',
    subtitle: '理解 Transformer 基础',
    description: '从零训练一个中文对话 AI，完整体验数据准备、分词器训练、模型构建、训练循环、推理测试的全流程。',
    level: '入门级',
    levelStars: 1,
    params: '~11M 参数',
    status: 'available',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    iconBg: 'bg-emerald-500/20',
  },
  {
    id: 'nanogpt',
    title: 'nanoGPT 2.0',
    subtitle: '更大规模的预训练',
    description: '基于 Karpathy 的 nanoGPT，训练 Shakespeare 文本生成模型，学习更大规模的预训练技术。',
    level: '进阶级',
    levelStars: 2,
    params: '~10M-124M 参数',
    status: 'available',
    gradient: 'from-blue-500/20 to-indigo-500/20',
    iconBg: 'bg-blue-500/20',
  },
  {
    id: 'nanogpt' as LabType, // placeholder
    title: 'Fine-tuning & RLHF',
    subtitle: '后训练技术',
    description: '学习监督微调（SFT）和人类反馈强化学习（RLHF），理解如何让模型更好地遵循指令。',
    level: '高级',
    levelStars: 3,
    params: '后训练阶段',
    status: 'locked',
    gradient: 'from-purple-500/20 to-pink-500/20',
    iconBg: 'bg-purple-500/20',
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
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">AI 模型训练实验室</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          亲手体验从数据到模型的完整训练流程，通过可视化交互理解 AI 是如何学习的
        </p>
      </div>

      {/* Lab Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
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
        <h2 className="text-lg font-semibold text-zinc-200 mb-4 text-center">学习路径</h2>
        <div className="flex items-center justify-center gap-2">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-emerald-400 text-sm font-medium">GPT-1 入门</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <span className="text-zinc-500 text-sm">nanoGPT 进阶</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <span className="text-zinc-500 text-sm">Fine-tuning</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
            <span className="text-zinc-500 text-sm">RLHF</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0d0d0f]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-3">
          {currentLab !== 'home' && (
            <button
              onClick={() => setCurrentLab('home')}
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              ← 返回
            </button>
          )}
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-emerald-400" />
            <h1 className="text-lg font-semibold text-zinc-100">
              {currentLab === 'home' ? '实验室' : currentLab === 'gpt1' ? 'GPT-1 对话模型' : 'nanoGPT 2.0'}
            </h1>
          </div>
        </div>
        <button
          onClick={() => setShowLab(false)}
          className="p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      {currentLab === 'home' && renderHome()}
      {currentLab === 'gpt1' && <GPT1Lab />}
      {currentLab === 'nanogpt' && <NanoGPTLab />}
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
