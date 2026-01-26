// ============================================================================
// TokenizerStage - 阶段 2: 分词器训练
// 展示 SentencePiece 分词原理，提供实时分词演示
// ============================================================================

import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronLeft, Type, Zap, BookOpen } from 'lucide-react';

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
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-blue-400" />
              什么是分词器？
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              计算机只能处理数字，所以我们需要将文本转换为数字序列。
              <span className="text-emerald-400">分词器（Tokenizer）</span>
              就是做这个转换的工具，它把文本切分成小单元（tokens），每个 token 对应一个数字 ID。
            </p>
          </div>

          {/* 分词算法说明 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">SentencePiece Unigram</h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <p>我们使用 SentencePiece 的 Unigram 模型进行分词：</p>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">1.</span>
                  <span><span className="text-zinc-300">无需空格分割：</span>直接处理原始文本，非常适合中文</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">2.</span>
                  <span><span className="text-zinc-300">子词切分：</span>常见词保持完整，罕见词被拆分</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-amber-400 mt-0.5">3.</span>
                  <span><span className="text-zinc-300">概率建模：</span>选择概率最高的分词方式</span>
                </li>
              </ul>
            </div>
          </div>

          {/* 词汇表配置 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">配置参数</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2 rounded-lg bg-zinc-800/50">
                <span className="text-sm text-zinc-400">词汇表大小</span>
                <span className="text-sm font-mono text-emerald-400">280</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-zinc-800/50">
                <span className="text-sm text-zinc-400">字符覆盖率</span>
                <span className="text-sm font-mono text-blue-400">99.5%</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-zinc-800/50">
                <span className="text-sm text-zinc-400">模型类型</span>
                <span className="text-sm font-mono text-purple-400">unigram</span>
              </div>
            </div>
          </div>

          {/* 代码展示 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">{'</>'}</span>
              tokenizer.py
            </h3>
            <pre className="font-mono text-xs bg-zinc-950 rounded-lg p-3 overflow-x-auto text-zinc-300">
{`import sentencepiece as spm

# 训练分词器
spm.SentencePieceTrainer.train(
    input="dialogue_corpus.txt",
    model_prefix="tokenizer",
    vocab_size=280,           # 词汇表大小
    character_coverage=0.995, # 字符覆盖率
    model_type='unigram'      # 算法类型
)

# 使用分词器
sp = spm.SentencePieceProcessor()
sp.load("tokenizer.model")

# 编码
tokens = sp.encode("你好")  # [42, 18]

# 解码
text = sp.decode([42, 18])  # "你好"`}
            </pre>
          </div>
        </div>

        {/* 右侧：交互区域 */}
        <div className="space-y-6">
          {/* 实时分词演示 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border border-blue-500/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-blue-400" />
              实时分词演示
            </h3>

            {/* 输入框 */}
            <div className="mb-4">
              <label className="text-xs text-zinc-500 mb-1 block">输入文本</label>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="输入任意中文文本..."
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* 分词结果 */}
            <div className="mb-4">
              <label className="text-xs text-zinc-500 mb-2 block">分词结果</label>
              <div className="flex flex-wrap gap-2 min-h-[60px] p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
                {tokens.map((token, index) => (
                  <div
                    key={index}
                    className="flex flex-col items-center p-2 rounded-lg bg-zinc-800 border border-zinc-700"
                  >
                    <span className="text-sm text-zinc-200 font-medium">
                      {token.token === '\n' ? '\\n' : token.token === ' ' ? '␣' : token.token}
                    </span>
                    <span className="text-xs text-blue-400 font-mono">{token.id}</span>
                  </div>
                ))}
                {tokens.length === 0 && (
                  <span className="text-sm text-zinc-600">输入文本查看分词结果</span>
                )}
              </div>
            </div>

            {/* 统计信息 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
                <div className="text-xl font-bold text-blue-400">{tokens.length}</div>
                <div className="text-xs text-zinc-500">Token 数量</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
                <div className="text-xl font-bold text-emerald-400">{inputText.length}</div>
                <div className="text-xs text-zinc-500">字符数量</div>
              </div>
            </div>
          </div>

          {/* 词汇表预览 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Type className="w-4 h-4 text-purple-400" />
              词汇表预览 (280 tokens)
            </h3>
            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
              {Object.entries(mockVocab).slice(0, 32).map(([token, id]) => (
                <div
                  key={token}
                  className="flex items-center justify-between p-2 rounded bg-zinc-800/50 text-xs"
                >
                  <span className="text-zinc-300">
                    {token === '\n' ? '\\n' : token === ' ' ? '␣' : token}
                  </span>
                  <span className="text-zinc-500 font-mono">{id}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-600 mt-2 text-center">显示前 32 个 tokens...</p>
          </div>

          {/* 编码解码示例 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">编码 ↔ 解码</h3>
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-zinc-800/50">
                <div className="text-xs text-zinc-500 mb-1">编码 (文本 → 数字)</div>
                <div className="font-mono text-sm">
                  <span className="text-zinc-300">"你好"</span>
                  <span className="text-zinc-600 mx-2">→</span>
                  <span className="text-blue-400">[42, 18]</span>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-800/50">
                <div className="text-xs text-zinc-500 mb-1">解码 (数字 → 文本)</div>
                <div className="font-mono text-sm">
                  <span className="text-blue-400">[42, 18]</span>
                  <span className="text-zinc-600 mx-2">→</span>
                  <span className="text-zinc-300">"你好"</span>
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
          下一步: 模型架构
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
