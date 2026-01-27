// ============================================================================
// Tokenizer - nanoGPT 分词器阶段
// 用通俗方式对比两种「认字方式」
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, BookOpen, Zap, Hash } from 'lucide-react';

interface TokenizerProps {
  onComplete: () => void;
  onBack: () => void;
}

// 示例文本
const sampleText = '今天天气真好！';

// 模拟的分词结果 - 一个字一个字认
const charTokens = [
  { text: '今', id: 12 },
  { text: '天', id: 35 },
  { text: '天', id: 35 },
  { text: '气', id: 48 },
  { text: '真', id: 56 },
  { text: '好', id: 23 },
  { text: '！', id: 5 },
];

// 按词组认
const bpeTokens = [
  { text: '今天', id: 1520 },
  { text: '天气', id: 2890 },
  { text: '真好', id: 4521 },
  { text: '！', id: 5 },
];

// 对比数据
const comparisonData = {
  char: {
    vocabSize: '65 个字',
    seqLength: '7 个',
    compression: '1倍',
    pros: ['学起来简单', '字表很小', '每个字都认识'],
    cons: ['要认的次数多', '理解慢', '学习效率低'],
  },
  bpe: {
    vocabSize: '5万 个词',
    seqLength: '4 个',
    compression: '1.75倍',
    pros: ['认的次数少', '理解快', '学习效率高'],
    cons: ['字典很大', '需要先学词', '偶尔有生词'],
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
          <BookOpen className="w-5 h-5 text-blue-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">🔤 AI 有两种「认字方式」</h3>
            <p className="text-sm text-zinc-400">
              就像小朋友学认字一样，可以
              <span className="text-emerald-400">「一个字一个字学」</span>，
              也可以<span className="text-blue-400">「按词组来学」</span>。
              哪种方式更聪明呢？让我们来对比看看！
            </p>
          </div>
        </div>
      </div>

      {/* Input Text */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-zinc-300">📝 让 AI 认这句话</label>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="w-full px-4 py-3 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-zinc-200 focus:outline-none focus:border-blue-500/50"
          placeholder="输入一句话试试..."
        />
      </div>

      {/* Tokenization Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">🔍 两种认字方式对比</h3>

        {/* Tab Switcher */}
        <div className="flex gap-3">
          <button
            onClick={() => setActiveTab('char')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm transition-all ${
              activeTab === 'char'
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-zinc-800/30 text-zinc-400 border border-zinc-700/30 hover:border-zinc-600'
            }`}
          >
            <Hash className="w-4 h-4" />
            方式一：一个字一个字认
          </button>
          <button
            onClick={() => setActiveTab('bpe')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm transition-all ${
              activeTab === 'bpe'
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'bg-zinc-800/30 text-zinc-400 border border-zinc-700/30 hover:border-zinc-600'
            }`}
          >
            <Zap className="w-4 h-4" />
            方式二：按词组认
          </button>
        </div>

        {/* Tokenization Result */}
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">{activeTab === 'char' ? '🔤' : '📖'}</span>
            <span className="text-sm text-zinc-400">
              {activeTab === 'char' ? 'AI 一个字一个字地认：' : 'AI 按词组来认：'}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {(activeTab === 'char' ? charTokens : bpeTokens).map((token, idx) => (
              <div
                key={idx}
                className="group relative flex flex-col items-center"
              >
                <div
                  className={`px-3 py-2 rounded-lg text-base border ${
                    activeTab === 'char'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                  }`}
                >
                  {token.text}
                </div>
                <div
                  className={`text-xs mt-1 font-bold ${
                    activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'
                  }`}
                >
                  #{token.id}
                </div>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="mt-4 pt-3 border-t border-zinc-800/50">
            <div className={`p-3 rounded-lg ${activeTab === 'char' ? 'bg-emerald-500/10' : 'bg-blue-500/10'}`}>
              <div className="flex items-center gap-4 text-sm">
                <span className={activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'}>
                  📊 认了 <strong>{activeTab === 'char' ? charTokens.length : bpeTokens.length}</strong> 次
                </span>
                <span className="text-zinc-500">|</span>
                <span className={activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'}>
                  ⚡ 效率：{comparisonData[activeTab].compression}
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                {activeTab === 'char'
                  ? '💡 每个字都要认一次，比较慢，但很简单！'
                  : '💡 把常见的词组合并，认的次数少了，效率更高！'}
              </p>
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
            <span className="text-lg">🔤</span>
            一个字一个字认
          </h4>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">字典大小</span>
              <span className="text-emerald-400 font-medium">{comparisonData.char.vocabSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">要认几次</span>
              <span className="text-emerald-400 font-medium">{comparisonData.char.seqLength}</span>
            </div>

            <div className="pt-2 border-t border-zinc-700/30">
              <div className="text-zinc-400 mb-2 text-xs">✅ 好处：</div>
              <ul className="space-y-1.5">
                {comparisonData.char.pros.map((pro, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-emerald-400 text-xs">
                    <span>👍</span>
                    {pro}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="text-zinc-400 mb-2 text-xs">❌ 坏处：</div>
              <ul className="space-y-1.5">
                {comparisonData.char.cons.map((con, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-red-400 text-xs">
                    <span>👎</span>
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
            <span className="text-lg">📖</span>
            按词组认（更聪明）
          </h4>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">字典大小</span>
              <span className="text-blue-400 font-medium">{comparisonData.bpe.vocabSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">要认几次</span>
              <span className="text-blue-400 font-medium">{comparisonData.bpe.seqLength}</span>
            </div>

            <div className="pt-2 border-t border-zinc-700/30">
              <div className="text-zinc-400 mb-2 text-xs">✅ 好处：</div>
              <ul className="space-y-1.5">
                {comparisonData.bpe.pros.map((pro, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-emerald-400 text-xs">
                    <span>👍</span>
                    {pro}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="text-zinc-400 mb-2 text-xs">❌ 坏处：</div>
              <ul className="space-y-1.5">
                {comparisonData.bpe.cons.map((con, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-red-400 text-xs">
                    <span>👎</span>
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
        <h3 className="text-sm font-medium text-zinc-300">🧠 「按词组认」是怎么学会的？</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <p className="text-xs text-zinc-500 mb-4">
            AI 通过「找规律」来学习哪些字经常一起出现，然后把它们合并成词：
          </p>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-lg">1️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">先把所有字拆开</div>
                <div className="text-xs text-zinc-500">比如：「今」「天」「天」「气」</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-lg">2️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">数一数哪些字总是挨在一起</div>
                <div className="text-xs text-zinc-500">发现「天」和「气」经常挨着出现</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-lg">3️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">把经常一起的字合并成「词」</div>
                <div className="text-xs text-zinc-500">于是「天」+「气」变成「天气」这个词</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-lg">4️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">不断重复，学会更多词</div>
                <div className="text-xs text-zinc-500">最终学会了 5 万个常用词！</div>
              </div>
            </div>
          </div>

          <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <div className="text-xs text-blue-400">
              💡 就像小朋友学说话：先学「爸」「妈」，后来发现它们经常一起说，
              就学会了「爸妈」这个词！
            </div>
          </div>
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
          下一步：认识 AI 的「大脑」
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
