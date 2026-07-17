// ============================================================================
// TokenizerStage - 阶段 2: 分词器训练
// 展示 SentencePiece 分词原理，提供实时分词演示
// ============================================================================

import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronLeft, Type, Zap, BookOpen } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

// 模拟分词器词汇表（简化版）
const mockVocab: Record<string, number> = {
  '你': 42, '好': 18, '，': 5, '今': 67, '天': 89, '天气': 123,
  '怎么': 156, '样': 78, '我': 12, '是': 34, '一': 56, '个': 90,
  '助': 112, '手': 145, '很': 23, '高': 45, '兴': 78, '和': 91,
  '聊': 134, '聊天': 167, '。': 3, '！': 4, '？': 6, '的': 8,
  '不': 15, '能': 28, '看': 39, '到': 51, '外': 63, '面': 75,
  '那': 87, '里': 99, '如': 111, '何': 122, '用户': 200, '助手': 201,
  ':': 2, '\n': 1, ' ': 0,
};

// 简化的分词函数
const tokenize = (text: string): { token: string; id: number }[] => {
  const result: { token: string; id: number }[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let matched = false;
    // 尝试匹配最长的词
    for (let len = Math.min(4, remaining.length); len >= 1; len--) {
      const substr = remaining.slice(0, len);
      if (mockVocab[substr] !== undefined) {
        result.push({ token: substr, id: mockVocab[substr] });
        remaining = remaining.slice(len);
        matched = true;
        break;
      }
    }
    // 如果没有匹配，作为单个未知字符处理
    if (!matched) {
      const char = remaining[0];
      result.push({ token: char, id: Math.floor(Math.random() * 280) });
      remaining = remaining.slice(1);
    }
  }

  return result;
};

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

export const TokenizerStage: React.FC<Props> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const tk = t.labGpt1.tokenizerStage;
  const [inputText, setInputText] = useState('你好，今天天气怎么样？');
  const [tokens, setTokens] = useState<{ token: string; id: number }[]>([]);

  // 实时分词
  useEffect(() => {
    if (inputText.trim()) {
      setTokens(tokenize(inputText));
    } else {
      setTokens([]);
    }
  }, [inputText]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：说明区域 */}
        <div className="space-y-6">
          {/* 概念说明 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-blue-400" />
              {tk.whyTitle}
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed mb-3">
              {tk.whyPrefix}
              <span className="text-emerald-400">{tk.whyHighlight}</span>
              {tk.whySuffix}
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {tk.whyExample}
            </p>
          </div>

          {/* 认字规则 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{tk.rulesTitle}</h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <span className="text-xl">📖</span>
                <div>
                  <div className="text-emerald-300 font-medium">{tk.ruleCommonLabel}</div>
                  <div className="text-xs text-zinc-500 mt-1">{tk.ruleCommonDesc}</div>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <span className="text-xl">✂️</span>
                <div>
                  <div className="text-blue-300 font-medium">{tk.ruleRareLabel}</div>
                  <div className="text-xs text-zinc-500 mt-1">{tk.ruleRareDesc}</div>
                </div>
              </div>
            </div>
          </div>

          {/* 词汇表配置 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{tk.vocabTitle}</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800">
                <span className="text-sm text-zinc-400">{tk.vocabCountLabel}</span>
                <span className="text-sm font-bold text-emerald-400">{tk.vocabCountValue}</span>
              </div>
              <p className="text-xs text-zinc-500">
                {tk.vocabHint}
              </p>
            </div>
          </div>

          {/* 工作流程 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{tk.demoTitle}</h3>
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-zinc-800">
                <div className="text-xs text-zinc-500 mb-2">{tk.demoStep1Label}</div>
                <div className="text-sm text-zinc-400">{tk.demoStep1Example}</div>
              </div>
              <div className="text-center text-zinc-600">{tk.demoArrow}</div>
              <div className="p-3 rounded-lg bg-zinc-800">
                <div className="text-xs text-zinc-500 mb-2">{tk.demoStep2Label}</div>
                <div className="text-sm">
                  <span className="text-emerald-400">{tk.demoStep2Example}</span>
                </div>
              </div>
              <p className="text-xs text-zinc-500 text-center">
                {tk.demoHint}
              </p>
            </div>
          </div>
        </div>

        {/* 右侧：交互区域 */}
        <div className="space-y-6">
          {/* 实时分词演示 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-blue-400" />
              {tk.liveTitle}
            </h3>

            {/* 输入框 */}
            <div className="mb-4">
              <label className="text-xs text-zinc-500 mb-1 block">{tk.liveInputLabel}</label>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={tk.liveInputPlaceholder}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500"
              />
            </div>

            {/* 分词结果 */}
            <div className="mb-4">
              <label className="text-xs text-zinc-500 mb-2 block">{tk.liveResultLabel}</label>
              <div className="flex flex-wrap gap-2 min-h-[60px] p-3 rounded-lg bg-zinc-900 border border-zinc-700">
                {tokens.map((token, index) => (
                  <div
                    key={index}
                    className="flex flex-col items-center p-2 rounded-lg bg-zinc-700 border border-zinc-700"
                  >
                    <span className="text-sm text-zinc-200 font-medium">
                      {token.token === '\n' ? '\\n' : token.token === ' ' ? '␣' : token.token}
                    </span>
                    <span className="text-xs text-blue-400 font-mono">{token.id}</span>
                  </div>
                ))}
                {tokens.length === 0 && (
                  <span className="text-sm text-zinc-600">{tk.liveResultEmpty}</span>
                )}
              </div>
            </div>

            {/* 统计信息 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-700">
                <div className="text-xl font-bold text-blue-400">{tokens.length}</div>
                <div className="text-xs text-zinc-500">{tk.liveTokenCount}</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-700">
                <div className="text-xl font-bold text-emerald-400">{inputText.length}</div>
                <div className="text-xs text-zinc-500">{tk.liveCharCount}</div>
              </div>
            </div>
          </div>

          {/* AI 的字典 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Type className="w-4 h-4 text-purple-400" />
              {tk.dictTitle}
            </h3>
            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
              {Object.entries(mockVocab).slice(0, 32).map(([token, id]) => (
                <div
                  key={token}
                  className="flex items-center justify-between p-2 rounded bg-zinc-800 text-xs"
                >
                  <span className="text-zinc-400">
                    {token === '\n' ? tk.dictNewline : token === ' ' ? tk.dictSpace : token}
                  </span>
                  <span className="text-emerald-400 font-bold">#{id}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-600 mt-2 text-center">
              {tk.dictHint}
            </p>
          </div>

          {/* 双向转换 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{tk.convertTitle}</h3>
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="text-xs text-emerald-400 mb-1">{tk.encodeLabel}</div>
                <div className="text-sm">
                  <span className="text-zinc-400">{tk.encodeExampleFrom}</span>
                  <span className="text-zinc-600 mx-2">{tk.encodeArrow}</span>
                  <span className="text-emerald-400 font-bold">{tk.encodeExampleTo}</span>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <div className="text-xs text-blue-400 mb-1">{tk.decodeLabel}</div>
                <div className="text-sm">
                  <span className="text-blue-400 font-bold">{tk.decodeExampleFrom}</span>
                  <span className="text-zinc-600 mx-2">{tk.decodeArrow}</span>
                  <span className="text-zinc-400">{tk.decodeExampleTo}</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-3 text-center">
              {tk.convertHint}
            </p>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="mt-8 p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {tk.termsTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {tk.terms.map((term) => (
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

      {/* 导航按钮 */}
      <div className="mt-8 flex justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-zinc-700 text-zinc-400 font-medium hover:bg-zinc-600 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          {tk.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
        >
          {tk.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
