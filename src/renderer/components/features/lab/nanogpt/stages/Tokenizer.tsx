// ============================================================================
// Tokenizer - nanoGPT 分词器阶段
// 用通俗方式对比两种「认字方式」
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, ChevronLeft, BookOpen, Zap, Hash } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

interface TokenizerProps {
  onComplete: () => void;
  onBack: () => void;
}

// 示例文本 —— 分词演示输入，下方 charTokens/bpeTokens 的编号与此字面量一一对应，
// 属于演示数据本身，不进 i18n（翻译会导致字符级/词组级切分示例失真）
const sampleText = '今天天气真好！';

// 模拟的分词结果 - 一个字一个字认（对应 sampleText，不进 i18n）
const charTokens = [
  { text: '今', id: 12 },
  { text: '天', id: 35 },
  { text: '天', id: 35 },
  { text: '气', id: 48 },
  { text: '真', id: 56 },
  { text: '好', id: 23 },
  { text: '！', id: 5 },
];

// 按词组认（对应 sampleText，不进 i18n）
const bpeTokens = [
  { text: '今天', id: 1520 },
  { text: '天气', id: 2890 },
  { text: '真好', id: 4521 },
  { text: '！', id: 5 },
];

export const Tokenizer: React.FC<TokenizerProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const tk = t.labNanogpt.tokenizer;
  const comparisonData = {
    char: {
      vocabSize: tk.charVocabSize,
      seqLength: tk.charSeqLength,
      compression: tk.charCompression,
      pros: tk.charPros,
      cons: tk.charCons,
    },
    bpe: {
      vocabSize: tk.bpeVocabSize,
      seqLength: tk.bpeSeqLength,
      compression: tk.bpeCompression,
      pros: tk.bpePros,
      cons: tk.bpeCons,
    },
  };
  const [activeTab, setActiveTab] = useState<'char' | 'bpe'>('char');
  const [inputText, setInputText] = useState(sampleText);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-lg border border-blue-500/20 p-4">
        <div className="flex items-start gap-3">
          <BookOpen className="w-5 h-5 text-blue-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{tk.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {tk.introBodyPre}
              <span className="text-emerald-400">{tk.introBodyHighlight1}</span>
              {tk.introBodyMid}
              <span className="text-blue-400">{tk.introBodyHighlight2}</span>
              {tk.introBodyPost}
            </p>
          </div>
        </div>
      </div>

      {/* Input Text */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-zinc-400">{tk.inputLabel}</label>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-hidden focus:border-blue-500/50"
          placeholder={tk.inputPlaceholder}
        />
      </div>

      {/* Tokenization Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{tk.comparisonLabel}</h3>

        {/* Tab Switcher */}
        <div className="flex gap-3">
          <button
            onClick={() => setActiveTab('char')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm transition-all ${
              activeTab === 'char'
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <Hash className="w-4 h-4" />
            {tk.tabCharLabel}
          </button>
          <button
            onClick={() => setActiveTab('bpe')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm transition-all ${
              activeTab === 'bpe'
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <Zap className="w-4 h-4" />
            {tk.tabBpeLabel}
          </button>
        </div>

        {/* Tokenization Result */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">{activeTab === 'char' ? '🔤' : '📖'}</span>
            <span className="text-sm text-zinc-400">
              {activeTab === 'char' ? tk.resultCharPrefix : tk.resultBpePrefix}
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
          <div className="mt-4 pt-3 border-t border-zinc-700">
            <div className={`p-3 rounded-lg ${activeTab === 'char' ? 'bg-emerald-500/10' : 'bg-blue-500/10'}`}>
              <div className="flex items-center gap-4 text-sm">
                <span className={activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'}>
                  {tk.statsCountLabel} <strong>{activeTab === 'char' ? charTokens.length : bpeTokens.length}</strong> {tk.statsCountSuffix}
                </span>
                <span className="text-zinc-500">|</span>
                <span className={activeTab === 'char' ? 'text-emerald-400' : 'text-blue-400'}>
                  {tk.statsEfficiencyLabel}{comparisonData[activeTab].compression}
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                {activeTab === 'char' ? tk.statsHintChar : tk.statsHintBpe}
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
              : 'bg-zinc-700/20 border-zinc-800'
          }`}
        >
          <h4 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
            <span className="text-lg">🔤</span>
            {tk.sideCharTitle}
          </h4>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">{tk.vocabSizeLabel}</span>
              <span className="text-emerald-400 font-medium">{comparisonData.char.vocabSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">{tk.seqLengthLabel}</span>
              <span className="text-emerald-400 font-medium">{comparisonData.char.seqLength}</span>
            </div>

            <div className="pt-2 border-t border-zinc-800">
              <div className="text-zinc-400 mb-2 text-xs">{tk.prosLabel}</div>
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
              <div className="text-zinc-400 mb-2 text-xs">{tk.consLabel}</div>
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
              : 'bg-zinc-700/20 border-zinc-800'
          }`}
        >
          <h4 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
            <span className="text-lg">📖</span>
            {tk.sideBpeTitle}
          </h4>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">{tk.vocabSizeLabel}</span>
              <span className="text-blue-400 font-medium">{comparisonData.bpe.vocabSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">{tk.seqLengthLabel}</span>
              <span className="text-blue-400 font-medium">{comparisonData.bpe.seqLength}</span>
            </div>

            <div className="pt-2 border-t border-zinc-800">
              <div className="text-zinc-400 mb-2 text-xs">{tk.prosLabel}</div>
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
              <div className="text-zinc-400 mb-2 text-xs">{tk.consLabel}</div>
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
        <h3 className="text-sm font-medium text-zinc-400">{tk.algoLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <p className="text-xs text-zinc-500 mb-4">
            {tk.algoIntro}
          </p>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-lg">1️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">{tk.algoStep1Title}</div>
                <div className="text-xs text-zinc-500">{tk.algoStep1Desc}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-lg">2️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">{tk.algoStep2Title}</div>
                <div className="text-xs text-zinc-500">{tk.algoStep2Desc}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-lg">3️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">{tk.algoStep3Title}</div>
                <div className="text-xs text-zinc-500">{tk.algoStep3Desc}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-lg">4️⃣</span>
              <div>
                <div className="text-sm text-zinc-200">{tk.algoStep4Title}</div>
                <div className="text-xs text-zinc-500">{tk.algoStep4Desc}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <div className="text-xs text-blue-400">
              {tk.algoFooter}
            </div>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {tk.glossaryLabel}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {tk.glossary.map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-zinc-800">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-zinc-500">|</span>
                <span className="text-sm text-zinc-400">{term.label}</span>
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
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 border border-zinc-700 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          {tk.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all font-medium"
        >
          {tk.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
