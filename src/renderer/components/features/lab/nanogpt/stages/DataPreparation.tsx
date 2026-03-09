// ============================================================================
// DataPreparation - nanoGPT 数据准备阶段
// 用通俗方式展示「准备阅读材料」的过程
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, FileText, Database, BookOpen, Play, Check } from 'lucide-react';

interface DataPreparationProps {
  onComplete: () => void;
}

type DatasetType = 'shakespeare' | 'openwebtext';

// 示例数据
const shakespearePreview = `第一市民：
在我们继续之前，请听我说。

众人：
说吧，说吧。

第一市民：
你们都宁愿死也不愿挨饿吗？

众人：
是的，是的。

第一市民：
首先，你们知道凯厄斯·马修斯是人民的死敌。`;

const tokenizedPreview = {
  shakespeare: [
    { char: '第', id: 24 },
    { char: '一', id: 47 },
    { char: '市', id: 56 },
    { char: '民', id: 57 },
    { char: '：', id: 10 },
    { char: '\n', id: 0 },
  ],
};

const datasetStats = {
  shakespeare: {
    totalChars: '约 100 万字',
    uniqueChars: '65 种',
    trainSize: '90 万字用来学',
    valSize: '10 万字用来考试',
    vocabType: '一个字一个字认',
  },
  openwebtext: {
    totalTokens: '约 90 亿词',
    uniqueTokens: '5 万个词',
    trainSize: '81 亿词用来学',
    valSize: '9 亿词用来考试',
    vocabType: '按常见词组认',
  },
};

export const DataPreparation: React.FC<DataPreparationProps> = ({ onComplete }) => {
  const [selectedDataset, setSelectedDataset] = useState<DatasetType>('shakespeare');
  const [preparationStep, setPreparationStep] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const preparationSteps = [
    { id: 0, title: '📚 找书', desc: '找到莎士比亚全集' },
    { id: 1, title: '📝 列字表', desc: '看看书里用了哪些字' },
    { id: 2, title: '🔢 编号', desc: '给每个字编上号码' },
    { id: 3, title: '✂️ 分堆', desc: '90%学习，10%考试' },
    { id: 4, title: '💾 保存', desc: '整理好放进书包' },
  ];

  const runPreparation = () => {
    setIsProcessing(true);
    let step = 0;
    const interval = setInterval(() => {
      step++;
      setPreparationStep(step);
      if (step >= preparationSteps.length) {
        clearInterval(interval);
        setIsProcessing(false);
      }
    }, 800);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* 概念说明 */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-purple-500/10 to-blue-500/10 border border-purple-500/20">
        <div className="flex items-start gap-3">
          <BookOpen className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">📖 给 AI 选「课外书」</h3>
            <p className="text-sm text-text-secondary">
              就像小朋友学说话需要听大人讲话一样，AI 学写作也需要
              <span className="text-purple-400">「阅读材料」</span>。
              我们给它准备书来读，它就能学会写类似的文字！
            </p>
          </div>
        </div>
      </div>

      {/* Dataset Selection */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">选择 AI 的「课外书」</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Shakespeare */}
          <button
            onClick={() => setSelectedDataset('shakespeare')}
            className={`p-4 rounded-lg border text-left transition-all ${
              selectedDataset === 'shakespeare'
                ? 'bg-emerald-500/10 border-emerald-500/50'
                : 'bg-surface border-border-default hover:border-border-strong'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">📚</span>
              <span className={`font-medium ${selectedDataset === 'shakespeare' ? 'text-emerald-400' : 'text-text-primary'}`}>
                经典名著
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">入门推荐</span>
            </div>
            <p className="text-xs text-text-tertiary">
              读莎士比亚的戏剧，约 100 万字，像「一本厚书」
            </p>
            <p className="text-xs text-emerald-400/70 mt-1">
              ✨ 学完后能写出「古典风格」的对话
            </p>
          </button>

          {/* OpenWebText */}
          <button
            onClick={() => setSelectedDataset('openwebtext')}
            className={`p-4 rounded-lg border text-left transition-all ${
              selectedDataset === 'openwebtext'
                ? 'bg-emerald-500/10 border-emerald-500/50'
                : 'bg-surface border-border-default hover:border-border-strong'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">🌐</span>
              <span className={`font-medium ${selectedDataset === 'openwebtext' ? 'text-emerald-400' : 'text-text-primary'}`}>
                网页百科
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">进阶挑战</span>
            </div>
            <p className="text-xs text-text-tertiary">
              读互联网上的文章，约 90 亿词，像「一整个图书馆」
            </p>
            <p className="text-xs text-amber-400/70 mt-1">
              ⚡ 需要很强的电脑才能学完
            </p>
          </button>
        </div>
      </div>

      {/* Data Preview */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">📖 书的内容长这样</h3>
        <div className="bg-deep rounded-lg border border-border-default p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📄</span>
            <span className="text-xs text-text-tertiary">
              {selectedDataset === 'shakespeare' ? '莎士比亚戏剧片段' : '网页文章片段'}
            </span>
          </div>
          <pre className="text-sm text-text-secondary whitespace-pre-wrap bg-void/50 p-3 rounded border border-border-default max-h-40 overflow-auto">
            {shakespearePreview}
          </pre>
          <p className="text-xs text-text-tertiary mt-2">
            💡 AI 会反复阅读这样的对话，学习「人物对话」的写法
          </p>
        </div>
      </div>

      {/* Dataset Statistics */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">📊 这本「书」有多厚？</h3>
        <div className="grid grid-cols-5 gap-3">
          {Object.entries(datasetStats[selectedDataset]).map(([key, value]) => (
            <div key={key} className="bg-surface rounded-lg p-3 border border-border-subtle">
              <div className="text-xs text-text-tertiary mb-1">
                {key === 'totalChars' && '📚 总字数'}
                {key === 'totalTokens' && '📚 总词数'}
                {key === 'uniqueChars' && '🔤 用了多少种字'}
                {key === 'uniqueTokens' && '📖 用了多少种词'}
                {key === 'trainSize' && '📝 学习用'}
                {key === 'valSize' && '✏️ 考试用'}
                {key === 'vocabType' && '👁️ 认字方式'}
              </div>
              <div className="text-sm font-medium text-emerald-400">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Encoding Visualization */}
      {selectedDataset === 'shakespeare' && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-text-secondary">🔢 把文字变成数字</h3>
          <div className="bg-deep rounded-lg border border-border-default p-4">
            <p className="text-xs text-text-tertiary mb-3">
              电脑只认识数字，所以要给每个字「编号」：
            </p>
            <div className="flex flex-wrap gap-2">
              {tokenizedPreview.shakespeare.map((token, idx) => (
                <div
                  key={idx}
                  className="group relative flex flex-col items-center"
                >
                  <div className="px-3 py-2 bg-surface rounded-lg text-base text-text-secondary border border-border-default">
                    {token.char === '\n' ? '换行' : token.char === ' ' ? '空格' : token.char}
                  </div>
                  <div className="text-xs text-emerald-400 mt-1 font-bold">#{token.id}</div>
                </div>
              ))}
              <div className="px-3 py-2 text-text-tertiary flex items-center">...</div>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="text-xs text-emerald-400">
                💡 就像给班级同学编学号一样！「第」是24号，「一」是47号...
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preparation Pipeline */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-secondary">🎬 准备工作流程（点击体验）</h3>
          <button
            onClick={runPreparation}
            disabled={isProcessing || preparationStep >= preparationSteps.length}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
              isProcessing || preparationStep >= preparationSteps.length
                ? 'bg-hover text-text-tertiary cursor-not-allowed'
                : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
            }`}
          >
            <Play className="w-4 h-4" />
            {preparationStep >= preparationSteps.length ? '✅ 准备好了！' : '▶️ 开始准备'}
          </button>
        </div>

        <div className="bg-deep rounded-lg border border-border-default p-4">
          <div className="flex items-center gap-2 flex-wrap">
            {preparationSteps.map((step, idx) => (
              <React.Fragment key={step.id}>
                <div
                  className={`flex flex-col items-center gap-1 ${
                    idx < preparationStep
                      ? 'opacity-100'
                      : idx === preparationStep && isProcessing
                        ? 'opacity-100'
                        : 'opacity-40'
                  }`}
                >
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center border transition-all text-lg ${
                      idx < preparationStep
                        ? 'bg-emerald-500/20 border-emerald-500/50'
                        : idx === preparationStep && isProcessing
                          ? 'bg-blue-500/20 border-blue-500/50 animate-pulse'
                          : 'bg-surface border-border-default'
                    }`}
                  >
                    {idx < preparationStep ? <Check className="w-5 h-5 text-emerald-400" /> : step.title.slice(0, 2)}
                  </div>
                  <span className="text-[10px] text-text-tertiary text-center w-16">{step.desc}</span>
                </div>
                {idx < preparationSteps.length - 1 && (
                  <ChevronRight className={`w-4 h-4 ${idx < preparationStep ? 'text-emerald-500' : 'text-text-disabled'}`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Output Files */}
      {preparationStep >= preparationSteps.length && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-text-secondary">🎒 准备好的「学习材料」</h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📗</span>
                <span className="text-sm text-text-primary">学习用的书</span>
              </div>
              <p className="text-xs text-text-tertiary">AI 平时学习用（90%的内容）</p>
            </div>
            <div className="bg-blue-500/10 rounded-lg p-3 border border-blue-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📘</span>
                <span className="text-sm text-text-primary">考试用的卷</span>
              </div>
              <p className="text-xs text-text-tertiary">测试 AI 学得好不好（10%的内容）</p>
            </div>
            <div className="bg-purple-500/10 rounded-lg p-3 border border-purple-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📒</span>
                <span className="text-sm text-text-primary">字典</span>
              </div>
              <p className="text-xs text-text-tertiary">记录每个字的编号</p>
            </div>
          </div>
          <p className="text-xs text-emerald-400 text-center">
            🎉 材料准备好了，可以开始学习啦！
          </p>
        </div>
      )}

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-deep border border-border-default">
        <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          本阶段专有名词
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { en: 'Dataset', zh: '数据集', desc: '用于训练 AI 的数据集合，可以是书籍、文章等' },
            { en: 'Train/Val Split', zh: '训练/验证集划分', desc: '把数据分成两部分：学习用和考试用，检验是否真的学会了' },
            { en: 'Character-level', zh: '字符级', desc: '一个字一个字地处理文本的方式，词汇表小但序列长' },
            { en: 'Corpus', zh: '语料库', desc: '大量文本数据的集合，AI 的"阅读材料"' },
          ].map((term) => (
            <div key={term.en} className="p-3 rounded-lg bg-surface">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-emerald-400">{term.en}</span>
                <span className="text-xs text-text-tertiary">|</span>
                <span className="text-sm text-text-secondary">{term.zh}</span>
              </div>
              <p className="text-xs text-text-tertiary">{term.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Next Button */}
      <div className="flex justify-end pt-4">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all font-medium"
        >
          下一步：教 AI 认字
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
