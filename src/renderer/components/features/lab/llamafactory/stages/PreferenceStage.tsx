// ============================================================================
// PreferenceStage - 偏好优化方法
// DPO/KTO/ORPO/SimPO 原理与对比
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  Heart,
  ThumbsUp,
  ThumbsDown,
  Zap,
  ArrowRight,
} from 'lucide-react';

interface PreferenceStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 偏好方法对比
const preferenceMethods = [
  {
    id: 'dpo',
    name: 'DPO',
    fullName: 'Direct Preference Optimization',
    zh: '直接偏好优化',
    description: '直接从偏好数据学习，无需训练 Reward Model',
    dataFormat: 'prompt + chosen + rejected',
    pros: ['实现简单', '训练稳定', '效果好'],
    cons: ['需要配对数据', '计算成本中等'],
    difficulty: 2,
    color: 'purple',
  },
  {
    id: 'kto',
    name: 'KTO',
    fullName: 'Kahneman-Tversky Optimization',
    zh: '卡尼曼-特沃斯基优化',
    description: '只需要单个好或坏的回答，数据更容易获取',
    dataFormat: 'prompt + response + label',
    pros: ['数据要求低', '易于收集', '效果接近 DPO'],
    cons: ['相对较新', '调参经验少'],
    difficulty: 2,
    color: 'blue',
  },
  {
    id: 'orpo',
    name: 'ORPO',
    fullName: 'Odds Ratio Preference Optimization',
    zh: '比值比偏好优化',
    description: 'SFT + 偏好优化一体化，单阶段完成',
    dataFormat: 'prompt + chosen + rejected',
    pros: ['单阶段训练', '效率高', '效果稳定'],
    cons: ['需要配对数据', '灵活性较低'],
    difficulty: 2,
    color: 'emerald',
  },
  {
    id: 'simpo',
    name: 'SimPO',
    fullName: 'Simple Preference Optimization',
    zh: '简化偏好优化',
    description: '简化版 DPO，无需参考模型，更节省资源',
    dataFormat: 'prompt + chosen + rejected',
    pros: ['无需参考模型', '显存更少', '训练更快'],
    cons: ['效果略逊于 DPO', '较新方法'],
    difficulty: 1,
    color: 'amber',
  },
];

// 偏好数据示例
const preferenceExample = {
  prompt: '请给我推荐一部电影',
  chosen: '我推荐《肖申克的救赎》！这是一部关于希望和自由的经典电影，讲述了银行家安迪在监狱中的故事。影片节奏紧凑，结局令人感动，非常值得一看。',
  rejected: '电影很多，你自己去网上搜吧。',
};

// SFT vs SFT+DPO 对比
const comparisonExamples = [
  {
    prompt: '如何看待加班文化？',
    sftOnly: '加班文化是指员工在正常工作时间之外继续工作的现象。它在很多公司中存在，有时是因为工作量大，有时是因为公司文化。加班有利有弊，可以提高产出但也会影响健康。',
    sftPlusDpo: '这是个值得深思的问题。首先我理解你可能正在经历加班困扰。\n\n从不同角度来看：\n1. 偶尔的项目冲刺可以理解\n2. 常态化加班往往意味着管理问题\n3. 身心健康应该是底线\n\n建议与上级坦诚沟通工作量，设定合理边界。你怎么看？',
    diff: 'SFT 给了正确但干巴巴的信息；DPO 后的回答更有同理心、更有结构、更有互动性',
  },
];

export const PreferenceStage: React.FC<PreferenceStageProps> = ({ onComplete, onBack }) => {
  const [selectedMethod, setSelectedMethod] = useState<string>('dpo');
  const [userChoice, setUserChoice] = useState<'chosen' | 'rejected' | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const getColorClasses = (color: string, isActive: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string; ring: string }> = {
      purple: { bg: 'bg-purple-500/20', border: 'border-purple-500/30', text: 'text-purple-400', ring: 'ring-purple-500/30' },
      blue: { bg: 'bg-blue-500/20', border: 'border-blue-500/30', text: 'text-blue-400', ring: 'ring-blue-500/30' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/30', text: 'text-emerald-400', ring: 'ring-emerald-500/30' },
      amber: { bg: 'bg-amber-500/20', border: 'border-amber-500/30', text: 'text-amber-400', ring: 'ring-amber-500/30' },
    };
    return colors[color] || colors.purple;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Heart className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">❤️ 偏好优化方法</h3>
            <p className="text-sm text-text-secondary">
              SFT 教会模型"怎么回答"，但没教"什么是好回答"。
              <span className="text-orange-400">偏好优化</span>让模型从人类偏好中学习，
              输出更有帮助、更安全、更符合期望的回答。
            </p>
          </div>
        </div>
      </div>

      {/* Preference Demo */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
          <ThumbsUp className="w-4 h-4 text-orange-400" />
          什么是偏好数据？试试选择
        </h3>
        <div className="bg-deep rounded-lg border border-border-default p-4">
          {/* Prompt */}
          <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <div className="text-xs text-blue-400 mb-1">用户问题</div>
            <p className="text-sm text-text-primary">{preferenceExample.prompt}</p>
          </div>

          {/* Choices */}
          <div className="grid grid-cols-2 gap-4">
            {/* Chosen */}
            <button
              onClick={() => setUserChoice('chosen')}
              className={`
                p-4 rounded-lg border text-left transition-all
                ${userChoice === 'chosen'
                  ? 'bg-emerald-500/20 border-emerald-500/30 ring-2 ring-emerald-500/30'
                  : 'bg-surface border-border-subtle hover:border-border-strong'
                }
              `}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">A</span>
                {userChoice === 'chosen' && <ThumbsUp className="w-4 h-4 text-emerald-400" />}
              </div>
              <p className="text-sm text-text-secondary">{preferenceExample.chosen}</p>
            </button>

            {/* Rejected */}
            <button
              onClick={() => setUserChoice('rejected')}
              className={`
                p-4 rounded-lg border text-left transition-all
                ${userChoice === 'rejected'
                  ? 'bg-red-500/20 border-red-500/30 ring-2 ring-red-500/30'
                  : 'bg-surface border-border-subtle hover:border-border-strong'
                }
              `}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">B</span>
                {userChoice === 'rejected' && <ThumbsDown className="w-4 h-4 text-red-400" />}
              </div>
              <p className="text-sm text-text-secondary">{preferenceExample.rejected}</p>
            </button>
          </div>

          {/* Feedback */}
          {userChoice && (
            <div className={`
              mt-4 p-3 rounded-lg
              ${userChoice === 'chosen' ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-amber-500/10 border border-amber-500/20'}
            `}>
              <p className="text-sm">
                {userChoice === 'chosen' ? (
                  <span className="text-emerald-400">
                    ✓ 正确！回答 A 更有帮助、更具体、更友好。这就是"chosen"（优选）回答。
                    模型会学习生成更接近 A 的回答。
                  </span>
                ) : (
                  <span className="text-amber-400">
                    回答 B 虽然"没错"，但缺乏帮助性。这就是"rejected"（劣选）回答。
                    模型会学习避免这种敷衍的风格。
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Method Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
          <Zap className="w-4 h-4 text-orange-400" />
          四种偏好优化方法对比
        </h3>
        <div className="grid grid-cols-4 gap-3">
          {preferenceMethods.map((method) => {
            const isSelected = selectedMethod === method.id;
            const colors = getColorClasses(method.color, isSelected);

            return (
              <button
                key={method.id}
                onClick={() => setSelectedMethod(method.id)}
                className={`
                  p-3 rounded-lg border text-left transition-all
                  ${isSelected
                    ? `${colors.bg} ${colors.border} ring-2 ${colors.ring}`
                    : 'bg-surface border-border-subtle hover:border-border-strong'
                  }
                `}
              >
                <div className={`text-lg font-bold ${isSelected ? colors.text : 'text-text-secondary'}`}>
                  {method.name}
                </div>
                <div className="text-xs text-text-tertiary mb-2">{method.zh}</div>
                <div className="flex items-center gap-0.5 mb-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <span
                      key={i}
                      className={`text-[10px] ${i < method.difficulty ? 'text-amber-400' : 'text-text-disabled'}`}
                    >
                      ★
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {/* Method Detail */}
        {selectedMethod && (
          <div className="bg-deep rounded-lg border border-border-default p-4">
            {(() => {
              const method = preferenceMethods.find(m => m.id === selectedMethod)!;
              const colors = getColorClasses(method.color, true);
              return (
                <>
                  <div className="flex items-center gap-3 mb-3">
                    <span className={`text-xl font-bold ${colors.text}`}>{method.name}</span>
                    <span className="text-sm text-text-tertiary">{method.fullName}</span>
                  </div>
                  <p className="text-sm text-text-secondary mb-4">{method.description}</p>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-3 rounded-lg bg-surface">
                      <div className="text-xs text-text-tertiary mb-2">数据格式</div>
                      <code className="text-xs text-orange-400">{method.dataFormat}</code>
                    </div>
                    <div className="p-3 rounded-lg bg-surface">
                      <div className="text-xs text-emerald-400 mb-2">优点</div>
                      <ul className="space-y-1">
                        {method.pros.map((pro, idx) => (
                          <li key={idx} className="text-xs text-text-secondary">+ {pro}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-3 rounded-lg bg-surface">
                      <div className="text-xs text-red-400 mb-2">缺点</div>
                      <ul className="space-y-1">
                        {method.cons.map((con, idx) => (
                          <li key={idx} className="text-xs text-text-secondary">- {con}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* SFT vs SFT+DPO */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-secondary">📊 SFT vs SFT+DPO 效果对比</h3>
          <button
            onClick={() => setShowComparison(!showComparison)}
            className={`
              px-3 py-1.5 rounded-lg text-xs transition-all
              ${showComparison
                ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                : 'bg-surface text-text-tertiary border border-border-subtle'
              }
            `}
          >
            {showComparison ? '隐藏对比' : '查看对比'}
          </button>
        </div>

        {showComparison && (
          <div className="bg-deep rounded-lg border border-border-default p-4">
            {comparisonExamples.map((example, idx) => (
              <div key={idx}>
                <div className="mb-3 p-2 rounded bg-blue-500/10 border border-blue-500/20">
                  <span className="text-xs text-blue-400">问题：</span>
                  <span className="text-sm text-text-secondary ml-2">{example.prompt}</span>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div className="p-3 rounded-lg bg-surface border border-border-subtle">
                    <div className="text-xs text-text-tertiary mb-2">仅 SFT</div>
                    <p className="text-sm text-text-secondary whitespace-pre-line">{example.sftOnly}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
                    <div className="text-xs text-purple-400 mb-2">SFT + DPO</div>
                    <p className="text-sm text-text-secondary whitespace-pre-line">{example.sftPlusDpo}</p>
                  </div>
                </div>

                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/20">
                  <span className="text-xs text-amber-400">💡 {example.diff}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Workflow */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">🔄 推荐工作流</h3>
        <div className="bg-deep rounded-lg border border-border-default p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1 text-center p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="text-2xl mb-1">📝</div>
              <div className="text-sm font-medium text-blue-400">SFT</div>
              <div className="text-xs text-text-tertiary">建立基础能力</div>
            </div>
            <ArrowRight className="w-6 h-6 text-text-disabled mx-4" />
            <div className="flex-1 text-center p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="text-2xl mb-1">❤️</div>
              <div className="text-sm font-medium text-purple-400">DPO/偏好优化</div>
              <div className="text-xs text-text-tertiary">学习人类偏好</div>
            </div>
            <ArrowRight className="w-6 h-6 text-text-disabled mx-4" />
            <div className="flex-1 text-center p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="text-2xl mb-1">✅</div>
              <div className="text-sm font-medium text-emerald-400">评估</div>
              <div className="text-xs text-text-tertiary">验证效果</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-text-tertiary text-center">
            先 SFT 再 DPO 效果更好。也可以用 ORPO 一步到位，但灵活性较低。
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">📌 小结</h4>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-text-secondary">DPO 是首选</strong>：实现简单、效果好、训练稳定</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-text-secondary">KTO 数据要求低</strong>：只需要标注好/坏，不需要配对</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-text-secondary">先 SFT 再偏好</strong>：两阶段效果通常优于单阶段</span>
          </li>
        </ul>
      </div>

      {/* 专有名词 */}
      <div className="p-4 rounded-xl bg-deep border border-border-default">
        <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'DPO', zh: '直接偏好优化', desc: 'Direct Preference Optimization，直接从偏好数据学习' },
            { en: 'KTO', zh: '卡尼曼-特沃斯基优化', desc: '只需单个标签的偏好学习方法' },
            { en: 'Chosen', zh: '优选回答', desc: '偏好数据中被标注为更好的回答' },
            { en: 'Rejected', zh: '劣选回答', desc: '偏好数据中被标注为较差的回答' },
          ].map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-surface">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-text-tertiary">|</span>
                <span className="text-sm text-text-secondary">{term.zh}</span>
              </div>
              <p className="text-xs text-text-tertiary">{term.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-surface text-text-secondary rounded-lg hover:bg-hover border border-border-default transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          下一步：RLHF 与 RFT
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
