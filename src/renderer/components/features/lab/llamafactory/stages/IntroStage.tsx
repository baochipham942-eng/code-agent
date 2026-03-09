// ============================================================================
// IntroStage - 微调全景图
// 介绍微调技术栈总览、各方法定位、LLaMA Factory
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronRight,
  Map,
  Check,
  X,
  Lightbulb,
  ArrowRight,
  Layers,
} from 'lucide-react';

interface IntroStageProps {
  onComplete: () => void;
}

// 微调技术栈流程
const pipelineSteps = [
  {
    id: 'pretrain',
    title: '预训练',
    subtitle: 'Pre-training',
    description: '海量文本学习语言知识',
    icon: '📚',
    color: 'zinc',
    detail: '在数 TB 级别的文本上训练，学习语法、事实、推理能力。耗时数月，花费数百万美元。',
  },
  {
    id: 'sft',
    title: 'SFT 监督微调',
    subtitle: 'Supervised Fine-Tuning',
    description: '学习按指令回答',
    icon: '📝',
    color: 'blue',
    detail: '用「指令 + 回答」对来训练，让模型学会理解人类指令并给出恰当回答。数据量通常在数千到数十万条。',
  },
  {
    id: 'alignment',
    title: '偏好对齐',
    subtitle: 'RLHF / DPO',
    description: '学习人类偏好',
    icon: '❤️',
    color: 'purple',
    detail: '让模型学会什么样的回答更好。RLHF 用强化学习，DPO 直接从偏好数据学习，效果相近但 DPO 更简单。',
  },
  {
    id: 'eval',
    title: '评估部署',
    subtitle: 'Evaluation & Deploy',
    description: '验证效果并上线',
    icon: '🚀',
    color: 'emerald',
    detail: '用测试集和人工评估验证效果，确保没有能力退化。通过后可以导出并部署到生产环境。',
  },
];

// 微调目标分类
const finetuningGoals = [
  {
    goal: '新增知识/能力',
    method: 'SFT',
    examples: ['学习新领域知识', '掌握特定任务格式', '适配业务场景'],
    icon: '🎓',
    color: 'blue',
  },
  {
    goal: '学习风格/偏好',
    method: 'DPO / PPO',
    examples: ['更有帮助的回答', '更安全的输出', '符合品牌调性'],
    icon: '❤️',
    color: 'purple',
  },
  {
    goal: '复杂推理能力',
    method: 'RFT',
    examples: ['数学推理', '代码生成', '逻辑分析'],
    icon: '🧠',
    color: 'amber',
  },
];

// 微调能/不能做什么
const canDo = [
  { text: '让模型学习特定格式或风格', example: '总是用 JSON 格式回复' },
  { text: '强化模型已有但不够好的能力', example: '提高代码质量' },
  { text: '让模型更可靠地遵循指令', example: '减少幻觉' },
  { text: '注入新的领域知识', example: '公司内部文档' },
];

const cannotDo = [
  { text: '让模型掌握全新的能力', example: '不会数学的模型学不会数学' },
  { text: '显著提高事实准确性', example: '用 RAG 更合适' },
  { text: '替代 prompt engineering', example: '先优化 prompt 再考虑微调' },
  { text: '修复所有安全问题', example: '需要多层防护' },
];

// LLaMA Factory 特性
const llamaFactoryFeatures = [
  { title: '100+ 模型支持', desc: 'LLaMA, Qwen, Mistral, Yi...', icon: '🦙' },
  { title: '多种微调方法', desc: 'LoRA, QLoRA, 全量微调', icon: '⚙️' },
  { title: '多种训练方式', desc: 'SFT, RLHF, DPO, ORPO...', icon: '📊' },
  { title: 'Web UI 界面', desc: '无需代码，点击即可训练', icon: '🖥️' },
];

export const IntroStage: React.FC<IntroStageProps> = ({ onComplete }) => {
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [expandedDecision, setExpandedDecision] = useState<'can' | 'cannot' | null>(null);

  const getColorClasses = (color: string, isActive: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string }> = {
      zinc: { bg: 'bg-zinc-600/20', border: 'border-zinc-600/30', text: 'text-zinc-400' },
      blue: { bg: 'bg-blue-500/20', border: 'border-blue-500/30', text: 'text-blue-400' },
      purple: { bg: 'bg-purple-500/20', border: 'border-purple-500/30', text: 'text-purple-400' },
      emerald: { bg: 'bg-emerald-500/20', border: 'border-emerald-500/30', text: 'text-emerald-400' },
      amber: { bg: 'bg-amber-500/20', border: 'border-amber-500/30', text: 'text-amber-400' },
      orange: { bg: 'bg-orange-500/20', border: 'border-orange-500/30', text: 'text-orange-400' },
    };
    return colors[color] || colors.zinc;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <Map className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🗺️ 微调全景图</h3>
            <p className="text-sm text-zinc-400">
              微调（Fine-tuning）是在预训练模型基础上，用特定数据进一步训练，让模型更好地完成目标任务。
              就像一个学过很多书的学生，再针对特定考试做专门练习。
            </p>
          </div>
        </div>
      </div>

      {/* Pipeline Overview */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Layers className="w-4 h-4 text-orange-400" />
          微调技术栈流程
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center justify-between gap-2">
            {pipelineSteps.map((step, index) => {
              const isSelected = selectedStep === step.id;
              const colors = getColorClasses(step.color, isSelected);

              return (
                <React.Fragment key={step.id}>
                  <button
                    onClick={() => setSelectedStep(isSelected ? null : step.id)}
                    className={`
                      flex-1 p-3 rounded-lg border transition-all text-center
                      ${isSelected
                        ? `${colors.bg} ${colors.border} ring-2 ring-${step.color}-500/30`
                        : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
                      }
                    `}
                  >
                    <div className="text-2xl mb-2">{step.icon}</div>
                    <div className={`text-sm font-medium ${isSelected ? colors.text : 'text-zinc-400'}`}>
                      {step.title}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">{step.subtitle}</div>
                  </button>
                  {index < pipelineSteps.length - 1 && (
                    <ArrowRight className="w-4 h-4 text-zinc-600 flex-shrink-0" />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Detail Panel */}
          {selectedStep && (
            <div className="mt-4 p-3 rounded-lg bg-zinc-800 border border-zinc-800">
              <p className="text-sm text-zinc-400">
                {pipelineSteps.find(s => s.id === selectedStep)?.detail}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Fine-tuning Goals */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-orange-400" />
          微调目标 → 方法选择
        </h3>
        <div className="grid grid-cols-3 gap-4">
          {finetuningGoals.map((item) => {
            const colors = getColorClasses(item.color, true);
            return (
              <div
                key={item.goal}
                className={`p-4 rounded-lg border ${colors.bg} ${colors.border}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">{item.icon}</span>
                  <span className={`text-sm font-medium ${colors.text}`}>{item.goal}</span>
                </div>
                <div className="text-xs text-zinc-400 mb-2">推荐方法：<span className="text-zinc-200">{item.method}</span></div>
                <ul className="space-y-1">
                  {item.examples.map((ex, idx) => (
                    <li key={idx} className="text-xs text-zinc-500 flex items-center gap-1">
                      <span className="text-zinc-600">•</span> {ex}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {/* Can / Cannot Do */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Check className="w-4 h-4 text-orange-400" />
          微调能/不能做什么？
        </h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Can Do */}
          <div
            className={`
              rounded-lg border transition-all cursor-pointer
              ${expandedDecision === 'can'
                ? 'bg-emerald-500/10 border-emerald-500/30'
                : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
              }
            `}
            onClick={() => setExpandedDecision(expandedDecision === 'can' ? null : 'can')}
          >
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <Check className="w-3 h-3 text-emerald-400" />
                </div>
                <span className="text-sm font-medium text-emerald-400">微调能做到</span>
              </div>
              <ul className="space-y-2">
                {canDo.map((item, idx) => (
                  <li key={idx} className="text-sm text-zinc-400">
                    <div className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-1">✓</span>
                      <div>
                        <span>{item.text}</span>
                        {expandedDecision === 'can' && (
                          <div className="text-xs text-zinc-500 mt-0.5">例：{item.example}</div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Cannot Do */}
          <div
            className={`
              rounded-lg border transition-all cursor-pointer
              ${expandedDecision === 'cannot'
                ? 'bg-red-500/10 border-red-500/30'
                : 'bg-zinc-800 border-zinc-800 hover:border-zinc-600'
              }
            `}
            onClick={() => setExpandedDecision(expandedDecision === 'cannot' ? null : 'cannot')}
          >
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-red-500/20 flex items-center justify-center">
                  <X className="w-3 h-3 text-red-400" />
                </div>
                <span className="text-sm font-medium text-red-400">微调做不到</span>
              </div>
              <ul className="space-y-2">
                {cannotDo.map((item, idx) => (
                  <li key={idx} className="text-sm text-zinc-400">
                    <div className="flex items-start gap-2">
                      <span className="text-red-400 mt-1">✗</span>
                      <div>
                        <span>{item.text}</span>
                        {expandedDecision === 'cannot' && (
                          <div className="text-xs text-zinc-500 mt-0.5">例：{item.example}</div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="text-xs text-zinc-500 text-center">
          点击卡片查看更多细节
        </div>
      </div>

      {/* LLaMA Factory Introduction */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <span className="text-lg">🦙</span>
          LLaMA Factory 是什么？
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <p className="text-sm text-zinc-400 mb-4">
            LLaMA Factory 是一个开源的大模型微调框架，支持多种模型和训练方法，提供 Web UI 界面，让微调变得简单高效。
          </p>
          <div className="grid grid-cols-4 gap-3">
            {llamaFactoryFeatures.map((feature) => (
              <div key={feature.title} className="p-3 rounded-lg bg-zinc-800 border border-zinc-800 text-center">
                <div className="text-2xl mb-2">{feature.icon}</div>
                <div className="text-sm font-medium text-zinc-400">{feature.title}</div>
                <div className="text-xs text-zinc-500 mt-1">{feature.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">📌 小结</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-400">微调流程</strong>：预训练 → SFT → 偏好对齐 → 评估部署</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-400">目标决定方法</strong>：新增能力用 SFT，学偏好用 DPO，练推理用 RFT</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400">•</span>
            <span><strong className="text-zinc-400">先尝试 prompt</strong>：微调是最后手段，先优化提示词</span>
          </li>
        </ul>
      </div>

      {/* 专有名词 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'Fine-tuning', zh: '微调', desc: '在预训练模型基础上用特定数据继续训练' },
            { en: 'SFT', zh: '监督微调', desc: 'Supervised Fine-Tuning，用标注数据训练' },
            { en: 'RLHF', zh: '人类反馈强化学习', desc: '用人类偏好反馈通过强化学习优化模型' },
            { en: 'DPO', zh: '直接偏好优化', desc: 'Direct Preference Optimization，简化版 RLHF' },
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
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          下一步：参数高效微调
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
