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

  // 层详情内容
  const layerDetails: Record<NonNullable<SelectedLayer>, { title: string; description: string; formula: string; params: string }> = {
    embedding: {
      title: 'Embedding 层',
      description: 'Token Embedding 将每个 token ID 映射到一个 384 维的向量。Position Embedding 为每个位置添加位置信息，让模型知道 token 的顺序。',
      formula: 'x = token_emb(input) + pos_emb(positions)',
      params: `Token Embedding: ${modelConfig.vocabSize} × ${modelConfig.nEmbd} = ${paramCounts.tokenEmb.toLocaleString()}\nPosition Embedding: ${modelConfig.blockSize} × ${modelConfig.nEmbd} = ${paramCounts.posEmb.toLocaleString()}`,
    },
    attention: {
      title: '自注意力层 (Self-Attention)',
      description: '让每个 token 可以"关注"序列中的其他 token。通过 Q (Query)、K (Key)、V (Value) 三个矩阵计算注意力权重，使用因果掩码确保只能看到之前的 token。',
      formula: 'Attention(Q,K,V) = softmax(QK^T / √d_k) × V',
      params: `Q, K, V, O 投影: 4 × ${modelConfig.nEmbd} × ${modelConfig.nEmbd} = ${paramCounts.perBlock.attn.toLocaleString()}\n注意力头数: ${modelConfig.nHead}，每头维度: ${modelConfig.nEmbd / modelConfig.nHead}`,
    },
    ffn: {
      title: '前馈神经网络 (FFN)',
      description: '两层全连接网络，先扩展到 4 倍维度（1536），经过 GELU 激活函数，再压缩回原维度（384）。这是模型"思考"的主要场所。',
      formula: 'FFN(x) = GELU(xW₁ + b₁)W₂ + b₂',
      params: `上投影: ${modelConfig.nEmbd} × ${4 * modelConfig.nEmbd} = ${(modelConfig.nEmbd * 4 * modelConfig.nEmbd).toLocaleString()}\n下投影: ${4 * modelConfig.nEmbd} × ${modelConfig.nEmbd} = ${(4 * modelConfig.nEmbd * modelConfig.nEmbd).toLocaleString()}`,
    },
    output: {
      title: '输出投影层',
      description: '将最后一层的隐藏状态（384 维）投影回词汇表大小（280），得到每个 token 的概率分布，用于预测下一个 token。',
      formula: 'logits = LayerNorm(x) × W_out',
      params: `输出投影: ${modelConfig.nEmbd} × ${modelConfig.vocabSize} = ${paramCounts.outputProj.toLocaleString()}`,
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
              GPT-1 架构图
            </h3>

            <div className="space-y-3">
              {/* Input */}
              <div className="text-center text-xs text-zinc-500 mb-2">
                输入: (batch, {modelConfig.blockSize})
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
                <div className="text-sm font-medium">Token Embedding + Position Embedding</div>
                <div className="text-xs text-zinc-500 mt-1">
                  ({modelConfig.vocabSize} → {modelConfig.nEmbd}) + ({modelConfig.blockSize} → {modelConfig.nEmbd})
                </div>
              </button>

              {/* Arrow */}
              <div className="text-center text-zinc-600">↓</div>

              {/* Transformer Blocks */}
              <div className="p-3 rounded-lg border border-zinc-700/50 bg-zinc-800/30">
                <div className="text-xs text-zinc-500 mb-2 text-center">Transformer Block × {modelConfig.nLayer}</div>

                {/* Attention */}
                <button
                  onClick={() => setSelectedLayer('attention')}
                  className={`w-full p-2 rounded-lg border mb-2 transition-all ${
                    selectedLayer === 'attention'
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                      : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs">LayerNorm → Multi-Head Self-Attention ({modelConfig.nHead} heads)</div>
                </button>

                {/* Residual */}
                <div className="text-center text-xs text-zinc-600 mb-2">+ 残差连接</div>

                {/* FFN */}
                <button
                  onClick={() => setSelectedLayer('ffn')}
                  className={`w-full p-2 rounded-lg border transition-all ${
                    selectedLayer === 'ffn'
                      ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                      : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs">LayerNorm → FFN ({modelConfig.nEmbd} → {4 * modelConfig.nEmbd} → {modelConfig.nEmbd})</div>
                </button>

                {/* Residual */}
                <div className="text-center text-xs text-zinc-600 mt-2">+ 残差连接</div>
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
                <div className="text-sm font-medium">LayerNorm → Linear</div>
                <div className="text-xs text-zinc-500 mt-1">
                  ({modelConfig.nEmbd} → {modelConfig.vocabSize})
                </div>
              </button>

              {/* Output */}
              <div className="text-center text-xs text-zinc-500 mt-2">
                输出: (batch, {modelConfig.blockSize}, {modelConfig.vocabSize}) → softmax → 下一个 token
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
              参数统计
            </h3>
            <div className="text-3xl font-bold text-blue-400 mb-2">
              {totalParams.toLocaleString()}
            </div>
            <div className="text-sm text-zinc-400">
              总参数量 (~{(totalParams / 1e6).toFixed(1)}M)
            </div>
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
              <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                <div className="text-xs text-zinc-500 mb-1">公式</div>
                <div className="font-mono text-sm text-emerald-400">
                  {layerDetails[selectedLayer].formula}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-800/50">
                <div className="text-xs text-zinc-500 mb-1">参数量</div>
                <pre className="font-mono text-xs text-zinc-300 whitespace-pre-wrap">
                  {layerDetails[selectedLayer].params}
                </pre>
              </div>
            </div>
          )}

          {/* 模型配置 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              模型配置
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: '词汇表大小', value: modelConfig.vocabSize, color: 'text-emerald-400' },
                { label: '上下文长度', value: modelConfig.blockSize, color: 'text-blue-400' },
                { label: 'Transformer 层数', value: modelConfig.nLayer, color: 'text-purple-400' },
                { label: '注意力头数', value: modelConfig.nHead, color: 'text-amber-400' },
                { label: '隐藏层维度', value: modelConfig.nEmbd, color: 'text-pink-400' },
                { label: '每头维度', value: modelConfig.nEmbd / modelConfig.nHead, color: 'text-cyan-400' },
              ].map((item) => (
                <div key={item.label} className="p-3 rounded-lg bg-zinc-800/50">
                  <div className={`text-xl font-bold ${item.color}`}>{item.value}</div>
                  <div className="text-xs text-zinc-500">{item.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 代码展示 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">{'</>'}</span>
              model.py (核心结构)
            </h3>
            <pre className="font-mono text-xs bg-zinc-950 rounded-lg p-3 overflow-x-auto text-zinc-300 max-h-64 overflow-y-auto">
{`class GPT1(nn.Module):
    def __init__(self, vocab_size, block_size,
                 n_layer, n_head, n_embd):
        super().__init__()
        # Embeddings
        self.tok_emb = nn.Embedding(vocab_size, n_embd)
        self.pos_emb = nn.Embedding(block_size, n_embd)

        # Transformer Blocks
        self.blocks = nn.ModuleList([
            Block(n_embd, n_head)
            for _ in range(n_layer)
        ])

        # Output
        self.ln_f = nn.LayerNorm(n_embd)
        self.head = nn.Linear(n_embd, vocab_size)

    def forward(self, idx):
        B, T = idx.shape

        # 1. Embedding
        tok = self.tok_emb(idx)           # (B,T,C)
        pos = self.pos_emb(torch.arange(T))
        x = tok + pos

        # 2. Transformer Blocks
        for block in self.blocks:
            x = block(x)

        # 3. Output Projection
        x = self.ln_f(x)
        logits = self.head(x)             # (B,T,V)

        return logits`}
            </pre>
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
