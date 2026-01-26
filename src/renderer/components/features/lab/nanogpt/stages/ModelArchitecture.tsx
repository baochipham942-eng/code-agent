// ============================================================================
// ModelArchitecture - nanoGPT 模型架构阶段
// 展示 GPT-2 架构与 GPT-1 的区别
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, Boxes, Layers, Calculator, ArrowRight } from 'lucide-react';

interface ModelArchitectureProps {
  onComplete: () => void;
  onBack: () => void;
}

type ModelSize = 'small' | 'medium' | 'large' | 'xl';

const modelSizes: Record<ModelSize, { name: string; params: string; layers: number; heads: number; dModel: number }> = {
  small: { name: 'GPT-2 Small', params: '124M', layers: 12, heads: 12, dModel: 768 },
  medium: { name: 'GPT-2 Medium', params: '350M', layers: 24, heads: 16, dModel: 1024 },
  large: { name: 'GPT-2 Large', params: '774M', layers: 36, heads: 20, dModel: 1280 },
  xl: { name: 'GPT-2 XL', params: '1.5B', layers: 48, heads: 25, dModel: 1600 },
};

// GPT-1 vs GPT-2 对比
const architectureComparison = [
  { feature: 'Layer Norm 位置', gpt1: 'Post-LN (后置)', gpt2: 'Pre-LN (前置)', highlight: true },
  { feature: '层数', gpt1: '12 层', gpt2: '12-48 层', highlight: false },
  { feature: '上下文长度', gpt1: '512', gpt2: '1024', highlight: false },
  { feature: '词汇表大小', gpt1: '~40,000 (BPE)', gpt2: '50,257 (BPE)', highlight: false },
  { feature: '初始化', gpt1: '标准初始化', gpt2: '残差缩放初始化', highlight: true },
  { feature: '激活函数', gpt1: 'GELU', gpt2: 'GELU', highlight: false },
];

export const ModelArchitecture: React.FC<ModelArchitectureProps> = ({ onComplete, onBack }) => {
  const [selectedSize, setSelectedSize] = useState<ModelSize>('small');
  const model = modelSizes[selectedSize];

  // 计算参数量
  const calculateParams = (layers: number, dModel: number, vocabSize: number = 50257) => {
    // Embedding: vocab_size * d_model + context_length * d_model
    const embedding = vocabSize * dModel + 1024 * dModel;
    // Per layer: 4 * d_model^2 (attention) + 8 * d_model^2 (ffn) + 4 * d_model (layer norms)
    const perLayer = 4 * dModel * dModel + 8 * dModel * dModel + 4 * dModel;
    const total = embedding + layers * perLayer;
    return (total / 1e6).toFixed(0);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* GPT-1 vs GPT-2 Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">GPT-1 vs GPT-2 架构对比</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800/50">
                <th className="px-4 py-3 text-left text-zinc-400 font-medium">特性</th>
                <th className="px-4 py-3 text-center text-zinc-400 font-medium">GPT-1</th>
                <th className="px-4 py-3 text-center text-zinc-400 font-medium">GPT-2</th>
              </tr>
            </thead>
            <tbody>
              {architectureComparison.map((row, idx) => (
                <tr
                  key={idx}
                  className={`border-b border-zinc-800/30 ${row.highlight ? 'bg-amber-500/5' : ''}`}
                >
                  <td className="px-4 py-3 text-zinc-300">
                    {row.feature}
                    {row.highlight && <span className="ml-2 text-amber-400">⭐</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-zinc-400">{row.gpt1}</td>
                  <td className="px-4 py-3 text-center text-blue-400">{row.gpt2}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pre-LN vs Post-LN Explanation */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Pre-LN vs Post-LN</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Post-LN (GPT-1) */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <h4 className="text-sm font-medium text-zinc-300 mb-3">Post-LN (GPT-1)</h4>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <div className="px-2 py-1 bg-zinc-700/50 rounded text-zinc-300">Input</div>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <div className="px-2 py-1 bg-blue-500/20 rounded text-blue-300">Attention</div>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <div className="px-2 py-1 bg-emerald-500/20 rounded text-emerald-300">+ Residual</div>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <div className="px-2 py-1 bg-amber-500/20 rounded text-amber-300">LayerNorm</div>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                梯度在深层网络中可能不稳定，训练更困难
              </p>
            </div>
          </div>

          {/* Pre-LN (GPT-2) */}
          <div className="bg-blue-500/5 rounded-lg border border-blue-500/30 p-4">
            <h4 className="text-sm font-medium text-blue-300 mb-3">Pre-LN (GPT-2) ✓</h4>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <div className="px-2 py-1 bg-zinc-700/50 rounded text-zinc-300">Input</div>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <div className="px-2 py-1 bg-amber-500/20 rounded text-amber-300">LayerNorm</div>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <div className="px-2 py-1 bg-blue-500/20 rounded text-blue-300">Attention</div>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <div className="px-2 py-1 bg-emerald-500/20 rounded text-emerald-300">+ Residual</div>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                梯度更稳定，可以训练更深的网络
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Model Size Selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">模型规模选择</h3>
        <div className="grid grid-cols-4 gap-3">
          {(Object.entries(modelSizes) as [ModelSize, typeof modelSizes.small][]).map(([key, size]) => (
            <button
              key={key}
              onClick={() => setSelectedSize(key)}
              className={`p-3 rounded-lg border text-left transition-all ${
                selectedSize === key
                  ? 'bg-blue-500/10 border-blue-500/50'
                  : 'bg-zinc-800/30 border-zinc-700/30 hover:border-zinc-600'
              }`}
            >
              <div className="text-sm font-medium text-zinc-200">{size.name}</div>
              <div className="text-lg font-bold text-blue-400">{size.params}</div>
              <div className="text-xs text-zinc-500">
                {size.layers}层 · {size.heads}头
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Architecture Visualization */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">架构可视化</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-6">
          <div className="flex items-center justify-center gap-4">
            {/* Input Embedding */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-16 bg-gradient-to-b from-emerald-500/20 to-emerald-500/5 border border-emerald-500/30 rounded-lg flex items-center justify-center">
                <span className="text-xs text-emerald-400">Token Embed</span>
              </div>
              <div className="text-[10px] text-zinc-500">{model.dModel}d</div>
            </div>

            <div className="text-zinc-500">+</div>

            {/* Position Embedding */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-16 bg-gradient-to-b from-amber-500/20 to-amber-500/5 border border-amber-500/30 rounded-lg flex items-center justify-center">
                <span className="text-xs text-amber-400">Pos Embed</span>
              </div>
              <div className="text-[10px] text-zinc-500">1024 × {model.dModel}</div>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-500" />

            {/* Transformer Blocks */}
            <div className="flex flex-col items-center gap-2">
              <div className="relative">
                <div className="w-32 h-20 bg-gradient-to-b from-blue-500/20 to-blue-500/5 border border-blue-500/30 rounded-lg flex flex-col items-center justify-center">
                  <Layers className="w-4 h-4 text-blue-400 mb-1" />
                  <span className="text-xs text-blue-400">Transformer Block</span>
                </div>
                <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 px-2 py-0.5 bg-blue-500/20 rounded text-[10px] text-blue-400">
                  × {model.layers}
                </div>
              </div>
              <div className="text-[10px] text-zinc-500 mt-2">{model.heads} heads</div>
            </div>

            <ArrowRight className="w-5 h-5 text-zinc-500" />

            {/* Output */}
            <div className="flex flex-col items-center gap-2">
              <div className="w-24 h-16 bg-gradient-to-b from-purple-500/20 to-purple-500/5 border border-purple-500/30 rounded-lg flex items-center justify-center">
                <span className="text-xs text-purple-400">LM Head</span>
              </div>
              <div className="text-[10px] text-zinc-500">50,257 vocab</div>
            </div>
          </div>
        </div>
      </div>

      {/* Parameter Calculator */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Calculator className="w-4 h-4 text-zinc-400" />
          参数量计算
        </h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-xs text-zinc-500">Embedding 层</div>
              <div className="font-mono text-sm text-zinc-300">
                vocab_size × d_model = 50,257 × {model.dModel}
              </div>
              <div className="text-xs text-emerald-400">
                ≈ {((50257 * model.dModel) / 1e6).toFixed(1)}M
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs text-zinc-500">每个 Transformer Block</div>
              <div className="font-mono text-sm text-zinc-300">
                12 × d_model² ≈ 12 × {model.dModel}²
              </div>
              <div className="text-xs text-blue-400">
                ≈ {((12 * model.dModel * model.dModel) / 1e6).toFixed(1)}M × {model.layers} 层
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-zinc-800/50 flex items-center justify-between">
            <span className="text-sm text-zinc-400">总参数量（估算）</span>
            <span className="text-lg font-bold text-blue-400">
              ~{calculateParams(model.layers, model.dModel)}M
            </span>
          </div>
        </div>
      </div>

      {/* nanoGPT Code Snippet */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">nanoGPT 配置示例</h3>
        <div className="bg-zinc-950/50 rounded-lg border border-zinc-800/50 p-4 font-mono text-xs">
          <pre className="text-zinc-300">
            <span className="text-zinc-500"># model.py 配置</span>
            {'\n'}
            <span className="text-blue-400">class</span>{' '}
            <span className="text-amber-400">GPTConfig</span>:
            {'\n'}
            {'    '}block_size: <span className="text-blue-400">int</span> ={' '}
            <span className="text-emerald-400">1024</span>
            {'\n'}
            {'    '}vocab_size: <span className="text-blue-400">int</span> ={' '}
            <span className="text-emerald-400">50257</span>
            {'\n'}
            {'    '}n_layer: <span className="text-blue-400">int</span> ={' '}
            <span className="text-emerald-400">{model.layers}</span>
            {'\n'}
            {'    '}n_head: <span className="text-blue-400">int</span> ={' '}
            <span className="text-emerald-400">{model.heads}</span>
            {'\n'}
            {'    '}n_embd: <span className="text-blue-400">int</span> ={' '}
            <span className="text-emerald-400">{model.dModel}</span>
            {'\n'}
            {'    '}dropout: <span className="text-blue-400">float</span> ={' '}
            <span className="text-emerald-400">0.0</span>
            {'\n'}
            {'    '}bias: <span className="text-blue-400">bool</span> ={' '}
            <span className="text-emerald-400">True</span>
          </pre>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800/50 text-zinc-400 rounded-lg hover:bg-zinc-800 border border-zinc-700/50 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          上一步
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all"
        >
          下一步：预训练
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
