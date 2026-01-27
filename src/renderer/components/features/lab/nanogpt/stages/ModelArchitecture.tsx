// ============================================================================
// ModelArchitecture - nanoGPT 模型架构阶段
// 用通俗方式介绍 AI 的「大脑」结构
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, Brain, Layers, ArrowRight } from 'lucide-react';

interface ModelArchitectureProps {
  onComplete: () => void;
  onBack: () => void;
}

type ModelSize = 'small' | 'medium' | 'large' | 'xl';

const modelSizes: Record<ModelSize, { name: string; params: string; layers: number; heads: number; dModel: number; analogy: string }> = {
  small: { name: '小型', params: '1.2 亿', layers: 12, heads: 12, dModel: 768, analogy: '像一个聪明的小学生' },
  medium: { name: '中型', params: '3.5 亿', layers: 24, heads: 16, dModel: 1024, analogy: '像一个博学的中学生' },
  large: { name: '大型', params: '7.7 亿', layers: 36, heads: 20, dModel: 1280, analogy: '像一个大学教授' },
  xl: { name: '超大型', params: '15 亿', layers: 48, heads: 25, dModel: 1600, analogy: '像一个领域专家' },
};

export const ModelArchitecture: React.FC<ModelArchitectureProps> = ({ onComplete, onBack }) => {
  const [selectedSize, setSelectedSize] = useState<ModelSize>('small');
  const model = modelSizes[selectedSize];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* 概念说明 */}
      <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-lg border border-purple-500/20 p-4">
        <div className="flex items-start gap-3">
          <Brain className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🧠 AI 的「大脑」长什么样？</h3>
            <p className="text-sm text-zinc-400">
              AI 的大脑是由很多层「思考单元」堆叠起来的。层数越多，就像大脑越发达，
              能理解的东西就越复杂。我们可以选择不同「大小」的大脑！
            </p>
          </div>
        </div>
      </div>

      {/* 大脑工作原理 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🔄 AI 大脑是怎么「思考」的？</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-3xl mb-2">👁️</div>
              <div className="text-sm font-medium text-emerald-400">看懂文字</div>
              <div className="text-xs text-zinc-500 mt-1">把文字变成 AI 能理解的信号</div>
            </div>
            <div className="text-center p-4 bg-blue-500/10 rounded-lg border border-blue-500/20">
              <div className="text-3xl mb-2">🤔</div>
              <div className="text-sm font-medium text-blue-400">层层思考</div>
              <div className="text-xs text-zinc-500 mt-1">每一层都会「琢磨」一遍，加深理解</div>
            </div>
            <div className="text-center p-4 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-3xl mb-2">💬</div>
              <div className="text-sm font-medium text-purple-400">说出答案</div>
              <div className="text-xs text-zinc-500 mt-1">把理解转化成文字输出</div>
            </div>
          </div>

          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <span className="text-lg">💡</span>
              <span>就像我们读书一样：先认字 → 理解意思 → 形成想法 → 说出来！</span>
            </div>
          </div>
        </div>
      </div>

      {/* Model Size Selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">📐 选择 AI 大脑的「尺寸」</h3>
        <div className="grid grid-cols-4 gap-3">
          {(Object.entries(modelSizes) as [ModelSize, typeof modelSizes.small][]).map(([key, size]) => (
            <button
              key={key}
              onClick={() => setSelectedSize(key)}
              className={`p-4 rounded-lg border text-left transition-all ${
                selectedSize === key
                  ? 'bg-blue-500/10 border-blue-500/50'
                  : 'bg-zinc-800/30 border-zinc-700/30 hover:border-zinc-600'
              }`}
            >
              <div className="text-sm font-medium text-zinc-200 mb-1">{size.name}大脑</div>
              <div className="text-lg font-bold text-blue-400">{size.params} 个神经元</div>
              <div className="text-xs text-zinc-500 mt-2">
                {size.layers} 层思考 · {size.heads} 个关注点
              </div>
              <div className="text-xs text-emerald-400/70 mt-1">
                {size.analogy}
              </div>
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-500 text-center">
          💡 神经元越多，AI 越聪明，但也需要更多计算资源
        </p>
      </div>

      {/* Architecture Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🎨 AI 大脑的「结构图」</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-6">
          <div className="flex items-center justify-center gap-3">
            {/* Input Embedding */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-20 bg-gradient-to-b from-emerald-500/20 to-emerald-500/5 border border-emerald-500/30 rounded-lg flex flex-col items-center justify-center">
                <span className="text-2xl">👁️</span>
                <span className="text-xs text-emerald-400 mt-1">看懂文字</span>
              </div>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-500" />

            {/* Transformer Blocks */}
            <div className="flex flex-col items-center gap-2">
              <div className="relative">
                <div className="w-36 h-20 bg-gradient-to-b from-blue-500/20 to-blue-500/5 border border-blue-500/30 rounded-lg flex flex-col items-center justify-center">
                  <Layers className="w-5 h-5 text-blue-400 mb-1" />
                  <span className="text-xs text-blue-400">思考层</span>
                </div>
                <div className="absolute -bottom-3 left-1/2 transform -translate-x-1/2 px-3 py-1 bg-blue-500/20 rounded-full text-xs text-blue-400 font-medium">
                  × {model.layers} 层
                </div>
              </div>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-500" />

            {/* Output */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-20 bg-gradient-to-b from-purple-500/20 to-purple-500/5 border border-purple-500/30 rounded-lg flex flex-col items-center justify-center">
                <span className="text-2xl">💬</span>
                <span className="text-xs text-purple-400 mt-1">说出来</span>
              </div>
            </div>
          </div>

          <div className="mt-6 text-center text-xs text-zinc-500">
            选择的「{model.name}大脑」有 <span className="text-blue-400 font-bold">{model.layers}</span> 层思考，
            每层有 <span className="text-blue-400 font-bold">{model.heads}</span> 个「关注点」同时思考
          </div>
        </div>
      </div>

      {/* 什么是「关注点」 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🎯 什么是「关注点」？</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <p className="text-sm text-zinc-400 mb-4">
            当 AI 读一句话时，它会同时从多个角度「关注」不同的内容：
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
              <div className="text-sm text-blue-400 font-medium mb-1">关注点 1</div>
              <div className="text-xs text-zinc-500">可能在看「谁做的」</div>
            </div>
            <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <div className="text-sm text-emerald-400 font-medium mb-1">关注点 2</div>
              <div className="text-xs text-zinc-500">可能在看「做了什么」</div>
            </div>
            <div className="p-3 bg-purple-500/10 rounded-lg border border-purple-500/20">
              <div className="text-sm text-purple-400 font-medium mb-1">关注点 3</div>
              <div className="text-xs text-zinc-500">可能在看「语气情感」</div>
            </div>
          </div>
          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="text-xs text-amber-400">
              💡 就像你读书时，可以同时注意故事情节、人物性格、写作手法... 关注点越多，理解越全面！
            </div>
          </div>
        </div>
      </div>

      {/* 总结 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">📊 你选择的 AI 大脑</h3>
        <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-lg border border-blue-500/20 p-4">
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-blue-400">{model.params}</div>
              <div className="text-xs text-zinc-500 mt-1">神经元数量</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">{model.layers}</div>
              <div className="text-xs text-zinc-500 mt-1">思考层数</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-purple-400">{model.heads}</div>
              <div className="text-xs text-zinc-500 mt-1">关注点数</div>
            </div>
            <div>
              <div className="text-lg font-medium text-amber-400">{model.analogy}</div>
              <div className="text-xs text-zinc-500 mt-1">相当于</div>
            </div>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'Transformer', zh: '变换器', desc: 'GPT 的核心架构，通过注意力机制理解文本' },
            { en: 'Attention Head', zh: '注意力头', desc: '同时从不同角度关注文本的机制，多个头并行工作' },
            { en: 'Layer', zh: '层', desc: '神经网络的处理单元，层数越多理解越深' },
            { en: 'Embedding Dimension', zh: '嵌入维度', desc: '每个词元用多少个数字表示，越大表达能力越强' },
            { en: 'Parameters', zh: '参数', desc: '模型中可学习的数值，决定模型的"知识容量"' },
            { en: 'Context Length', zh: '上下文长度', desc: '模型一次能看多少个词元，影响理解范围' },
          ].map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800/50">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-300">{term.zh}</span>
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
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all font-medium"
        >
          下一步：开始学习
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
