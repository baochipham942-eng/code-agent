// ============================================================================
// LabPage - 实验室主页面
// 模型训练学习平台入口
// ============================================================================

import React, { useState } from 'react';
import { FlaskConical, Sparkles, Lock, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import type { Translations } from '../../../i18n/zh';
import { GPT1Lab } from './gpt1/GPT1Lab';
import { NanoGPTLab } from './nanogpt/NanoGPTLab';
import { AlignmentLab } from './alignment/AlignmentLab';
import { LLaMAFactoryLab } from './llamafactory/LLaMAFactoryLab';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

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

function buildLabCards(t: Translations): LabCard[] {
  return [
    {
      id: 'gpt1',
      ...t.lab.cards.gpt1,
      levelStars: 1,
      status: 'available',
      gradient: 'from-emerald-500/20 to-teal-500/20',
      iconBg: 'bg-emerald-500/20',
    },
    {
      id: 'nanogpt',
      ...t.lab.cards.nanogpt,
      levelStars: 2,
      status: 'available',
      gradient: 'from-blue-500/20 to-indigo-500/20',
      iconBg: 'bg-blue-500/20',
    },
    {
      id: 'alignment',
      ...t.lab.cards.alignment,
      levelStars: 3,
      status: 'available',
      gradient: 'from-purple-500/20 to-pink-500/20',
      iconBg: 'bg-purple-500/20',
    },
    {
      id: 'llamafactory',
      ...t.lab.cards.llamafactory,
      levelStars: 3,
      status: 'available',
      gradient: 'from-orange-500/20 to-amber-500/20',
      iconBg: 'bg-orange-500/20',
    },
  ];
}

export const LabPage: React.FC = () => {
  const { setShowLab } = useAppStore();
  const { t } = useI18n();
  const [currentLab, setCurrentLab] = useState<LabType>('home');
  const labCards = buildLabCards(t);
  const currentLabCard = labCards.find((card) => card.id === currentLab);
  const currentLabTitle = currentLab === 'home' ? t.lab.title : currentLabCard?.title ?? t.lab.title;
  const currentLabDescription = currentLab === 'home'
    ? t.lab.subtitle
    : currentLabCard?.subtitle;

  // 渲染主页卡片选择
  const renderHome = () => (
    <div className="flex-1 overflow-y-auto p-8">
      {/* Hero Section */}
      <div className="text-center mb-12">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 mb-4">
          <FlaskConical className="w-8 h-8 text-emerald-400" />
        </div>
        <h1 className="text-2xl font-bold text-zinc-200 mb-2">{t.lab.heroTitle}</h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          {t.lab.heroSubtitle}
        </p>
      </div>

      {/* Lab Cards - 4 列布局 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 max-w-6xl mx-auto">
        {labCards.map((card, index) => (
          <LabCardComponent
            key={`${card.id}-${index}`}
            card={card}
            comingSoonLabel={t.lab.comingSoon}
            startLearningLabel={t.lab.startLearning}
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
        <h2 className="text-lg font-semibold text-zinc-200 mb-4 text-center">{t.lab.recommendedPath}</h2>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-emerald-400 text-sm font-medium">{t.lab.pathSteps[0]}</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700">
            <span className="text-zinc-500 text-sm">{t.lab.pathSteps[1]}</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700">
            <span className="text-zinc-500 text-sm">{t.lab.pathSteps[2]}</span>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-600" />
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700">
            <span className="text-zinc-500 text-sm">{t.lab.pathSteps[3]}</span>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mt-3 text-center">
          {t.lab.pathHint}
        </p>
      </div>
    </div>
  );

  return (
    <FullScreenPage testId="lab-page">
      <FullScreenPageHeader
        icon={<FlaskConical className="h-4 w-4 text-emerald-300" />}
        title={currentLabTitle}
        description={currentLabDescription}
        onClose={() => setShowLab(false)}
        closeLabel={t.lab.closeLabel}
      />

      {/* Content */}
      {currentLab === 'home' && renderHome()}
      {currentLab === 'gpt1' && <GPT1Lab />}
      {currentLab === 'nanogpt' && <NanoGPTLab />}
      {currentLab === 'alignment' && <AlignmentLab />}
      {currentLab === 'llamafactory' && <LLaMAFactoryLab />}
    </FullScreenPage>
  );
};

// 实验卡片组件
const LabCardComponent: React.FC<{
  card: LabCard;
  comingSoonLabel: string;
  startLearningLabel: string;
  onClick: () => void;
}> = ({ card, comingSoonLabel, startLearningLabel, onClick }) => {
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
        border border-zinc-700
        ${isAvailable ? 'hover:border-zinc-700 hover:scale-[1.02] cursor-pointer' : 'cursor-not-allowed opacity-60'}
      `}
    >
      {/* Status Badge */}
      {isComingSoon && (
        <div className="absolute top-4 right-4 px-2 py-1 rounded-full bg-amber-500/20 border border-amber-500/30">
          <span className="text-xs text-amber-400">{comingSoonLabel}</span>
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
      <h3 className="text-lg font-semibold text-zinc-200 mb-1">{card.title}</h3>
      <p className="text-sm text-zinc-400 mb-3">{card.subtitle}</p>

      {/* Description */}
      <p className="text-xs text-zinc-500 mb-4 line-clamp-2">{card.description}</p>

      {/* Meta */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <span
              key={i}
              className={`text-xs ${i < card.levelStars ? 'text-amber-400' : 'text-zinc-600'}`}
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
        <div className="mt-4 pt-4 border-t border-zinc-700">
          <span className="text-sm text-emerald-400 flex items-center gap-1">
            {startLearningLabel} <ChevronRight className="w-4 h-4" />
          </span>
        </div>
      )}
    </button>
  );
};
