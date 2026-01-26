// ============================================================================
// Tokenizer - nanoGPT 分词器阶段
// 对比字符级分词与 BPE（GPT-2）分词
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, Type, Zap, Hash, BarChart3 } from 'lucide-react';

interface TokenizerProps {
  onComplete: () => void;
  onBack: () => void;
}

// 示例文本
const sampleText = 'Hello, how are you doing today?';

// 模拟的分词结果
const charTokens = sampleText.split('').map((char, idx) => ({
  text: char === ' ' ? '␣' : char,
  id: char.charCodeAt(0) % 100,
}));

const bpeTokens = [
  { text: 'Hello', id: 15496 },
  { text: ',', id: 11 },
  { text: ' how', id: 703 },
  { text: ' are', id: 389 },
  { text: ' you', id: 345 },
  { text: ' doing', id: 1804 },
  { text: ' today', id: 1909 },
  { text: '?', id: 30 },
];

// 对比数据
const comparisonData = {
  char: {
    vocabSize: '65',
    seqLength: '31 tokens',
    compression: '1.0x',
    example: 'H e l l o , ␣ h o w ...',
    pros: ['简单直接', '词汇表小', '无未知词'],
    cons: ['序列过长', '难以学习语义', '训练慢'],
  },
  bpe: {
    vocabSize: '50,257',
    seqLength: '8 tokens',
    compression: '3.9x',
    example: 'Hello , how are you doing today ?',
    pros: ['序列短', '保留语义', '训练快'],
    cons: ['词汇表大', '需要预训练', '可能有 UNK'],
  },
};

export const Tokenizer: React.FC<TokenizerProps> = ({ onComplete, onBack }) => {
  const [activeTab, setActiveTab] = useState<'char' | 'bpe'>('char');
  const [inputText, setInputText] = useState(sampleText);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-lg border border-blue-500/20 p-4">
        <div className="flex items-start gap-3">
          <Type className="w-5 h-5 text-blue-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">分词器的作用</h3>
            <p className="text-xs text-zinc-400">
              分词器将文本转换为模型可以处理的数字序列。nanoGPT 支持两种方式：
              <strong className="text-zinc-300">字符级分词</strong>（Shakespeare）和
              <strong className="text-zinc-300">BPE 子词分词</strong>（GPT-2）。
            </p>
          </div>
        </div>
      </div>

      {/* Input Text */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-zinc-300">测试文本</label>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="w-full px-4 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-zinc-200 text-sm focus:outline-none focus:border-blue-500/50"
          placeholder="输入测试文本..."
        />
      </div>

      {/* Tokenization Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">分词方式对比</h3>

        {/* Tab Switcher */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('char')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
              activeTab === 'char'
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-zinc-800/30 text-zinc-400 border border-zinc-700/30 hover:border-zinc-600'
            }`}
          >
            <Hash className="w-4 h-4" />
            字符级分词
          </button>
          <button
            onClick={() => setActiveTab('bpe')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
              activeTab === 'bpe'
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'bg-zinc-800/30 text-zinc-400 border border-zinc-700/30 hover:border-zinc-600'
            }`}
          >
            <Zap className="w-4 h-4" />
            BPE 分词 (GPT-2)
          </button>
        </div>

        {/* Tokenization Result */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Type className="w-4 h-4 text-zinc-400" />
            <span className="text-xs text-zinc-500">
              {activeTab === 'char' ? '字符级分词结果' : 'BPE 分词结果 (tiktoken)'}
            </span>
          </div>

          <div className="flex flex-wrap gap-1">
            {(activeTab === 'char' ? charTokens : bpeTokens).map((token, idx) => (
              <div
                key={idx}
                className={`group relative flex flex-col items-center ${
                  activeTab === 'char' ? 'min-w-[28px]' : 'min-w-[40px]'
                }`}
              >
                <div
                  className={`px-2 py-1 rounded text-sm font-mono border ${
                    activeTab === 'char'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                  }`}
                >
                  {token.text}
                </div>
                <div
                  className={`text-[10px] mt-0.5 ${
                    activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'
                  }`}
                >
                  {token.id}
                </div>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="mt-4 pt-3 border-t border-zinc-800/50 flex items-center gap-6">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-zinc-500" />
              <span className="text-xs text-zinc-500">
                Token 数量:{' '}
                <span className={activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'}>
                  {activeTab === 'char' ? charTokens.length : bpeTokens.length}
                </span>
              </span>
            </div>
            <div className="text-xs text-zinc-500">
              压缩率:{' '}
              <span className={activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'}>
                {comparisonData[activeTab].compression}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Side by Side Comparison */}
      <div className="grid grid-cols-2 gap-4">
        {/* Char Level */}
        <div
          className={`rounded-lg border p-4 transition-all ${
            activeTab === 'char'
              ? 'bg-emerald-500/5 border-emerald-500/30'
              : 'bg-zinc-800/20 border-zinc-700/30'
          }`}
        >
          <h4 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
            <Hash className="w-4 h-4 text-emerald-400" />
            字符级分词
          </h4>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">词汇表大小</span>
              <span className="text-zinc-200">{comparisonData.char.vocabSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">序列长度</span>
              <span className="text-zinc-200">{comparisonData.char.seqLength}</span>
            </div>

            <div className="pt-2 border-t border-zinc-700/30">
              <div className="text-zinc-400 mb-2">优点：</div>
              <ul className="space-y-1">
                {comparisonData.char.pros.map((pro, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-emerald-400">
                    <span className="w-1 h-1 rounded-full bg-emerald-400" />
                    {pro}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="text-zinc-400 mb-2">缺点：</div>
              <ul className="space-y-1">
                {comparisonData.char.cons.map((con, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-red-400">
                    <span className="w-1 h-1 rounded-full bg-red-400" />
                    {con}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* BPE */}
        <div
          className={`rounded-lg border p-4 transition-all ${
            activeTab === 'bpe'
              ? 'bg-blue-500/5 border-blue-500/30'
              : 'bg-zinc-800/20 border-zinc-700/30'
          }`}
        >
          <h4 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
            <Zap className="w-4 h-4 text-blue-400" />
            BPE 子词分词
          </h4>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">词汇表大小</span>
              <span className="text-zinc-200">{comparisonData.bpe.vocabSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">序列长度</span>
              <span className="text-zinc-200">{comparisonData.bpe.seqLength}</span>
            </div>

            <div className="pt-2 border-t border-zinc-700/30">
              <div className="text-zinc-400 mb-2">优点：</div>
              <ul className="space-y-1">
                {comparisonData.bpe.pros.map((pro, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-emerald-400">
                    <span className="w-1 h-1 rounded-full bg-emerald-400" />
                    {pro}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="text-zinc-400 mb-2">缺点：</div>
              <ul className="space-y-1">
                {comparisonData.bpe.cons.map((con, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-red-400">
                    <span className="w-1 h-1 rounded-full bg-red-400" />
                    {con}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* BPE Algorithm Explanation */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">BPE 算法原理</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-xs text-blue-400">
                1
              </div>
              <div>
                <div className="text-sm text-zinc-200">初始化</div>
                <div className="text-xs text-zinc-500">将文本拆分为字符序列</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-xs text-blue-400">
                2
              </div>
              <div>
                <div className="text-sm text-zinc-200">统计相邻对频率</div>
                <div className="text-xs text-zinc-500">找出出现最频繁的相邻字符对</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-xs text-blue-400">
                3
              </div>
              <div>
                <div className="text-sm text-zinc-200">合并</div>
                <div className="text-xs text-zinc-500">将最频繁的对合并为新的 token，加入词汇表</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-xs text-blue-400">
                4
              </div>
              <div>
                <div className="text-sm text-zinc-200">重复</div>
                <div className="text-xs text-zinc-500">重复步骤 2-3，直到达到目标词汇表大小（GPT-2: 50257）</div>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-zinc-800/50">
            <div className="text-xs text-zinc-500 font-mono bg-zinc-950/50 p-2 rounded">
              <span className="text-zinc-400"># tiktoken 使用示例</span>
              <br />
              <span className="text-blue-400">import</span> tiktoken
              <br />
              enc = tiktoken.get_encoding(<span className="text-emerald-400">"gpt2"</span>)
              <br />
              tokens = enc.encode(<span className="text-emerald-400">"Hello, world!"</span>)
              <br />
              <span className="text-zinc-500"># [15496, 11, 995, 0]</span>
            </div>
          </div>
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
          下一步：模型架构
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
