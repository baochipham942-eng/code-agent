// ============================================================================
// ModelArchitecture - 阶段 3: 模型架构
// 展示 GPT-1 Transformer 结构，可视化各层组件
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, Layers, Box, Zap, Info } from 'lucide-react';

// 模型配置
const modelConfig = {
  vocabSize: 280,
  blockSize: 128,
  nLayer: 6,
  nHead: 6,
  nEmbd: 384,
};

// 参数计算
const paramCounts = {
  tokenEmb: modelConfig.vocabSize * modelConfig.nEmbd,
  posEmb: modelConfig.blockSize * modelConfig.nEmbd,
  perBlock: {
    attn: 4 * modelConfig.nEmbd * modelConfig.nEmbd, // Q, K, V, O projections
    ffn: 2 * modelConfig.nEmbd * (4 * modelConfig.nEmbd), // up + down
    layerNorm: 4 * modelConfig.nEmbd, // 2 layer norms
  },
  outputProj: modelConfig.nEmbd * modelConfig.vocabSize,
};

const totalPerBlock = paramCounts.perBlock.attn + paramCounts.perBlock.ffn + paramCounts.perBlock.layerNorm;
const totalParams = paramCounts.tokenEmb + paramCounts.posEmb + (totalPerBlock * modelConfig.nLayer) + paramCounts.outputProj;

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

type SelectedLayer = 'embedding' | 'attention' | 'ffn' | 'output' | null;

export const ModelArchitecture: React.FC<Props> = ({ onComplete, onBack }) => {
  const [selectedLayer, setSelectedLayer] = useState<SelectedLayer>(null);

  // 层详情内容 - 用通俗的比喻解释
  const layerDetails: Record<NonNullable<SelectedLayer>, { title: string; description: string; analogy: string; simple: string }> = {
    embedding: {
      title: '把字变成"感觉"',
      description: '电脑不认识汉字，只认识数字。这一层把每个字变成一串数字（384个数字），这些数字代表了这个字的"含义"。',
      analogy: '🎨 就像画家用RGB颜色来表示颜色一样，AI用一串数字来表示每个字的"感觉"',
      simple: `每个字 → ${modelConfig.nEmbd} 个数字`,
    },
    attention: {
      title: '理解前后文关系',
      description: '这是 AI 最神奇的能力！它能同时"看"句子里的所有字，理解它们之间的关系。比如"苹果很甜"和"苹果公司"里的"苹果"意思不同，AI 就是通过这一层来理解的。',
      analogy: '👀 就像读书时，你会联系上下文来理解一个词的意思',
      simple: `同时关注 ${modelConfig.nHead} 个不同的方面`,
    },
    ffn: {
      title: '深度思考',
      description: '上一层理解了字之间的关系，这一层负责"消化"这些信息，进行更深入的分析和推理。',
      analogy: '🧠 就像大脑处理信息：先把信息"展开"仔细分析，再"归纳"成结论',
      simple: '信息 → 展开分析 → 归纳总结',
    },
    output: {
      title: '猜下一个字',
      description: '根据前面所有字的信息，猜测下一个最可能出现的字是什么。每个字都会得到一个"可能性分数"。',
      analogy: '🎯 就像填空题：根据上文，猜最合适的下一个字',
      simple: `从 ${modelConfig.vocabSize} 个字中选出最可能的`,
    },
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：架构可视化 */}
        <div className="space-y-6">
          {/* 架构图 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              AI 大脑结构图
            </h3>

            <div className="space-y-3">
              {/* Input */}
              <div className="text-center text-xs text-zinc-500 mb-2">
                ⬇️ 输入一句话（最多 {modelConfig.blockSize} 个字）
              </div>

              {/* Embedding Layer */}
              <button
                onClick={() => setSelectedLayer('embedding')}
                className={`w-full p-3 rounded-lg border transition-all ${
                  selectedLayer === 'embedding'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <div className="text-sm font-medium">把字变成数字</div>
                <div className="text-xs text-zinc-500 mt-1">
                  每个字 → {modelConfig.nEmbd} 个数字
                </div>
              </button>

              {/* Arrow */}
              <div className="text-center text-zinc-600">↓</div>

              {/* Transformer Blocks */}
              <div className="p-3 rounded-lg border border-zinc-700/50 bg-zinc-800/30">
                <div className="text-xs text-zinc-500 mb-2 text-center">🧠 思考层 × {modelConfig.nLayer}（重复 {modelConfig.nLayer} 遍，想得更深）</div>

                {/* Attention */}
                <button
                  onClick={() => setSelectedLayer('attention')}
                  className={`w-full p-2 rounded-lg border mb-2 transition-all ${
                    selectedLayer === 'attention'
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                      : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs">👀 理解上下文关系</div>
                </button>

                {/* Residual */}
                <div className="text-center text-xs text-zinc-600 mb-2">↓ 保留之前的信息</div>

                {/* FFN */}
                <button
                  onClick={() => setSelectedLayer('ffn')}
                  className={`w-full p-2 rounded-lg border transition-all ${
                    selectedLayer === 'ffn'
                      ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                      : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs">🧠 深度思考和分析</div>
                </button>

                {/* Residual */}
                <div className="text-center text-xs text-zinc-600 mt-2">↓ 保留之前的信息</div>
              </div>

              {/* Arrow */}
              <div className="text-center text-zinc-600">↓</div>

              {/* Output Layer */}
              <button
                onClick={() => setSelectedLayer('output')}
                className={`w-full p-3 rounded-lg border transition-all ${
                  selectedLayer === 'output'
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                    : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <div className="text-sm font-medium">🎯 猜下一个字</div>
                <div className="text-xs text-zinc-500 mt-1">
                  从 {modelConfig.vocabSize} 个字中选一个
                </div>
              </button>

              {/* Output */}
              <div className="text-center text-xs text-zinc-500 mt-2">
                ⬇️ 输出：最可能的下一个字
              </div>
            </div>

            <p className="text-xs text-zinc-600 mt-4 text-center">
              点击各层查看详细说明 ↑
            </p>
          </div>

          {/* 参数统计 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Box className="w-4 h-4 text-blue-400" />
              AI 大脑有多大？
            </h3>
            <div className="text-3xl font-bold text-blue-400 mb-2">
              ~{(totalParams / 1e6).toFixed(0)} 百万
            </div>
            <div className="text-sm text-zinc-400">
              个可调节的"旋钮"（参数）
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              💡 ChatGPT 有约 1750 亿个参数，是这个的 1.5 万倍！
            </p>
          </div>
        </div>

        {/* 右侧：详情和代码 */}
        <div className="space-y-6">
          {/* 层详情 */}
          {selectedLayer && (
            <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50 animate-fadeIn">
              <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
                <Info className="w-4 h-4 text-emerald-400" />
                {layerDetails[selectedLayer].title}
              </h3>
              <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
                {layerDetails[selectedLayer].description}
              </p>
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-3">
                <div className="text-sm text-amber-300">
                  {layerDetails[selectedLayer].analogy}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-800/50">
                <div className="text-xs text-zinc-500 mb-1">简单来说</div>
                <div className="text-sm text-emerald-400">
                  {layerDetails[selectedLayer].simple}
                </div>
              </div>
            </div>
          )}

          {/* 模型配置 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              AI 大脑的"配置"
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: '能认识多少字', value: modelConfig.vocabSize, color: 'text-emerald-400' },
                { label: '一次能看多少字', value: modelConfig.blockSize, color: 'text-blue-400' },
                { label: '思考多少遍', value: modelConfig.nLayer, color: 'text-purple-400' },
                { label: '同时关注几个方面', value: modelConfig.nHead, color: 'text-amber-400' },
              ].map((item) => (
                <div key={item.label} className="p-3 rounded-lg bg-zinc-800/50">
                  <div className={`text-xl font-bold ${item.color}`}>{item.value}</div>
                  <div className="text-xs text-zinc-500">{item.label}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-3">
              💡 这些数字越大，AI 越"聪明"，但也需要更多计算资源
            </p>
          </div>

          {/* 工作流程 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">🔄</span>
              AI 是怎么"想"的？
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <span className="text-2xl">📝</span>
                <div>
                  <div className="text-sm text-emerald-300 font-medium">第 1 步：认字</div>
                  <div className="text-xs text-zinc-400">把"你好"变成数字 [45, 78]</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <span className="text-2xl">🔗</span>
                <div>
                  <div className="text-sm text-blue-300 font-medium">第 2 步：理解关系</div>
                  <div className="text-xs text-zinc-400">"你"和"好"组合起来是打招呼的意思</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                <span className="text-2xl">🧠</span>
                <div>
                  <div className="text-sm text-purple-300 font-medium">第 3 步：深度思考</div>
                  <div className="text-xs text-zinc-400">根据对话习惯，应该回一句问候...</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <span className="text-2xl">🎯</span>
                <div>
                  <div className="text-sm text-amber-300 font-medium">第 4 步：输出</div>
                  <div className="text-xs text-zinc-400">猜测下一个字最可能是"你"（接着说"你好"）</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 导航按钮 */}
      <div className="mt-8 flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-zinc-800 text-zinc-300 font-medium hover:bg-zinc-700 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
        >
          下一步: 训练循环
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
