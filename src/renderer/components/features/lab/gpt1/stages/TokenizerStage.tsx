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
              为什么要教 AI 认字？
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed mb-3">
              电脑只认识数字（0、1、2...），不认识汉字。所以我们需要给每个字
              <span className="text-emerald-400">「编个号」</span>，
              就像给学生分配学号一样。
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              「你」= 42号，「好」= 18号... 这样 AI 就能用数字来「认字」了！
            </p>
          </div>

          {/* 认字规则 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">AI 的「认字」规则</h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <span className="text-xl">📖</span>
                <div>
                  <div className="text-emerald-300 font-medium">常见的组合 → 记成一个词</div>
                  <div className="text-xs text-zinc-500 mt-1">比如「天气」经常一起出现，就当成一个单位</div>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <span className="text-xl">✂️</span>
                <div>
                  <div className="text-blue-300 font-medium">不常见的 → 拆成单个字</div>
                  <div className="text-xs text-zinc-500 mt-1">生僻词就一个字一个字地认</div>
                </div>
              </div>
            </div>
          </div>

          {/* 词汇表配置 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">AI 认识多少字？</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50">
                <span className="text-sm text-zinc-400">总共能认的字/词</span>
                <span className="text-sm font-bold text-emerald-400">280 个</span>
              </div>
              <p className="text-xs text-zinc-500">
                💡 这是一个「迷你」词汇表，只够日常对话用。真正的 ChatGPT 能认识几万个词！
              </p>
            </div>
          </div>

          {/* 工作流程 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">认字过程演示</h3>
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-zinc-800/50">
                <div className="text-xs text-zinc-500 mb-2">第 1 步：看到一句话</div>
                <div className="text-sm text-zinc-300">「你好，今天天气怎么样？」</div>
              </div>
              <div className="text-center text-zinc-600">↓ 查字典，找编号</div>
              <div className="p-3 rounded-lg bg-zinc-800/50">
                <div className="text-xs text-zinc-500 mb-2">第 2 步：翻译成数字</div>
                <div className="text-sm">
                  <span className="text-emerald-400">[42, 18, 5, 67, 123, 156, 78, 6]</span>
                </div>
              </div>
              <p className="text-xs text-zinc-500 text-center">
                这样 AI 就能「读懂」这句话了！
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

          {/* AI 的字典 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Type className="w-4 h-4 text-purple-400" />
              AI 的「字典」（部分）
            </h3>
            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
              {Object.entries(mockVocab).slice(0, 32).map(([token, id]) => (
                <div
                  key={token}
                  className="flex items-center justify-between p-2 rounded bg-zinc-800/50 text-xs"
                >
                  <span className="text-zinc-300">
                    {token === '\n' ? '换行' : token === ' ' ? '空格' : token}
                  </span>
                  <span className="text-emerald-400 font-bold">#{id}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-600 mt-2 text-center">
              每个字/词都有自己的「学号」👆
            </p>
          </div>

          {/* 双向转换 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">字 ↔ 数字 可以互相转换</h3>
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="text-xs text-emerald-400 mb-1">📝 文字 → 数字（AI 读取时）</div>
                <div className="text-sm">
                  <span className="text-zinc-300">「你好」</span>
                  <span className="text-zinc-600 mx-2">变成</span>
                  <span className="text-emerald-400 font-bold">[42, 18]</span>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <div className="text-xs text-blue-400 mb-1">💬 数字 → 文字（AI 输出时）</div>
                <div className="text-sm">
                  <span className="text-blue-400 font-bold">[42, 18]</span>
                  <span className="text-zinc-600 mx-2">变回</span>
                  <span className="text-zinc-300">「你好」</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-3 text-center">
              💡 就像密码本：知道规则就能加密解密
            </p>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="mt-8 p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'Tokenizer', zh: '分词器', desc: '把文本切分成词元的工具，相当于 AI 的"认字本"' },
            { en: 'Vocabulary', zh: '词汇表', desc: 'AI 认识的所有字/词的集合，每个都有唯一编号' },
            { en: 'Token ID', zh: '词元编号', desc: '每个字/词对应的数字编号，AI 通过编号来"认字"' },
            { en: 'Encoding', zh: '编码', desc: '把文字转换成数字的过程（文字 → 数字）' },
            { en: 'Decoding', zh: '解码', desc: '把数字转换回文字的过程（数字 → 文字）' },
            { en: 'BPE', zh: '字节对编码', desc: 'Byte Pair Encoding，一种常用的分词算法' },
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
