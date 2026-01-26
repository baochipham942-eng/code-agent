// ============================================================================
// DataPreparation - nanoGPT 数据准备阶段
// 展示 Shakespeare / OpenWebText 数据集准备流程
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, FileText, Database, BarChart3, Play, Check } from 'lucide-react';

interface DataPreparationProps {
  onComplete: () => void;
}

type DatasetType = 'shakespeare' | 'openwebtext';

// 示例数据
const shakespearePreview = `First Citizen:
Before we proceed any further, hear me speak.

All:
Speak, speak.

First Citizen:
You are all resolved rather to die than to famish?

All:
Resolved. resolved.

First Citizen:
First, you know Caius Marcius is chief enemy to the people.`;

const tokenizedPreview = {
  shakespeare: [
    { char: 'F', id: 24 },
    { char: 'i', id: 47 },
    { char: 'r', id: 56 },
    { char: 's', id: 57 },
    { char: 't', id: 58 },
    { char: ' ', id: 1 },
    { char: 'C', id: 21 },
    { char: 'i', id: 47 },
    { char: 't', id: 58 },
    { char: 'i', id: 47 },
    { char: 'z', id: 64 },
    { char: 'e', id: 43 },
    { char: 'n', id: 52 },
    { char: ':', id: 10 },
    { char: '\n', id: 0 },
  ],
};

const datasetStats = {
  shakespeare: {
    totalChars: '1,115,394',
    uniqueChars: '65',
    trainSize: '1,003,854 chars (90%)',
    valSize: '111,540 chars (10%)',
    vocabType: '字符级',
  },
  openwebtext: {
    totalTokens: '~9B tokens',
    uniqueTokens: '50,257',
    trainSize: '~8.1B tokens (90%)',
    valSize: '~0.9B tokens (10%)',
    vocabType: 'BPE 子词',
  },
};

export const DataPreparation: React.FC<DataPreparationProps> = ({ onComplete }) => {
  const [selectedDataset, setSelectedDataset] = useState<DatasetType>('shakespeare');
  const [preparationStep, setPreparationStep] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const preparationSteps = [
    { id: 0, title: '下载原始数据', desc: '获取 Shakespeare 全集文本' },
    { id: 1, title: '构建词汇表', desc: '统计所有唯一字符' },
    { id: 2, title: '编码转换', desc: '字符 → 整数 ID' },
    { id: 3, title: '划分数据集', desc: '90% 训练 / 10% 验证' },
    { id: 4, title: '保存二进制', desc: '生成 train.bin / val.bin' },
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
      {/* Dataset Selection */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">选择数据集</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Shakespeare */}
          <button
            onClick={() => setSelectedDataset('shakespeare')}
            className={`p-4 rounded-lg border text-left transition-all ${
              selectedDataset === 'shakespeare'
                ? 'bg-emerald-500/10 border-emerald-500/50'
                : 'bg-zinc-800/30 border-zinc-700/50 hover:border-zinc-600'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <FileText
                className={`w-5 h-5 ${selectedDataset === 'shakespeare' ? 'text-emerald-400' : 'text-zinc-400'}`}
              />
              <span className={`font-medium ${selectedDataset === 'shakespeare' ? 'text-emerald-400' : 'text-zinc-200'}`}>
                Shakespeare
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">推荐入门</span>
            </div>
            <p className="text-xs text-zinc-500">
              莎士比亚全集，~1.1M 字符，字符级分词，适合快速实验
            </p>
          </button>

          {/* OpenWebText */}
          <button
            onClick={() => setSelectedDataset('openwebtext')}
            className={`p-4 rounded-lg border text-left transition-all ${
              selectedDataset === 'openwebtext'
                ? 'bg-emerald-500/10 border-emerald-500/50'
                : 'bg-zinc-800/30 border-zinc-700/50 hover:border-zinc-600'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <Database
                className={`w-5 h-5 ${selectedDataset === 'openwebtext' ? 'text-emerald-400' : 'text-zinc-400'}`}
              />
              <span className={`font-medium ${selectedDataset === 'openwebtext' ? 'text-emerald-400' : 'text-zinc-200'}`}>
                OpenWebText
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">大规模</span>
            </div>
            <p className="text-xs text-zinc-500">
              网页文本复现 WebText，~9B tokens，BPE 分词，需要大量计算
            </p>
          </button>
        </div>
      </div>

      {/* Data Preview */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">数据预览</h3>
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-4 h-4 text-zinc-400" />
            <span className="text-xs text-zinc-500">
              {selectedDataset === 'shakespeare' ? 'input.txt 片段' : 'sample.txt 片段'}
            </span>
          </div>
          <pre className="text-sm text-zinc-300 font-mono whitespace-pre-wrap bg-zinc-950/50 p-3 rounded border border-zinc-800/50 max-h-40 overflow-auto">
            {shakespearePreview}
          </pre>
        </div>
      </div>

      {/* Dataset Statistics */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">数据集统计</h3>
        <div className="grid grid-cols-5 gap-3">
          {Object.entries(datasetStats[selectedDataset]).map(([key, value]) => (
            <div key={key} className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
              <div className="text-xs text-zinc-500 mb-1">
                {key === 'totalChars' && '总字符数'}
                {key === 'totalTokens' && '总 Token 数'}
                {key === 'uniqueChars' && '唯一字符'}
                {key === 'uniqueTokens' && '词汇表大小'}
                {key === 'trainSize' && '训练集'}
                {key === 'valSize' && '验证集'}
                {key === 'vocabType' && '分词类型'}
              </div>
              <div className="text-sm font-medium text-zinc-200">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Encoding Visualization */}
      {selectedDataset === 'shakespeare' && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-300">字符编码过程</h3>
          <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
            <div className="flex flex-wrap gap-1">
              {tokenizedPreview.shakespeare.map((token, idx) => (
                <div
                  key={idx}
                  className="group relative flex flex-col items-center"
                >
                  <div className="px-2 py-1 bg-zinc-800/50 rounded text-sm font-mono text-zinc-300 border border-zinc-700/50">
                    {token.char === '\n' ? '↵' : token.char === ' ' ? '␣' : token.char}
                  </div>
                  <div className="text-[10px] text-emerald-400 mt-0.5">{token.id}</div>
                </div>
              ))}
              <div className="px-2 py-1 text-zinc-500">...</div>
            </div>
            <div className="mt-3 text-xs text-zinc-500 flex items-center gap-2">
              <BarChart3 className="w-3 h-3" />
              <span>每个字符映射到唯一的整数 ID（0-64）</span>
            </div>
          </div>
        </div>
      )}

      {/* Preparation Pipeline */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">数据准备流程</h3>
          <button
            onClick={runPreparation}
            disabled={isProcessing || preparationStep >= preparationSteps.length}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all ${
              isProcessing || preparationStep >= preparationSteps.length
                ? 'bg-zinc-700/50 text-zinc-500 cursor-not-allowed'
                : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
            }`}
          >
            <Play className="w-3 h-3" />
            {preparationStep >= preparationSteps.length ? '已完成' : '运行模拟'}
          </button>
        </div>

        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <div className="flex items-center gap-2">
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
                    className={`w-8 h-8 rounded-full flex items-center justify-center border transition-all ${
                      idx < preparationStep
                        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                        : idx === preparationStep && isProcessing
                          ? 'bg-blue-500/20 border-blue-500/50 text-blue-400 animate-pulse'
                          : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
                    }`}
                  >
                    {idx < preparationStep ? <Check className="w-4 h-4" /> : idx + 1}
                  </div>
                  <span className="text-[10px] text-zinc-500 text-center w-16">{step.title}</span>
                </div>
                {idx < preparationSteps.length - 1 && (
                  <ChevronRight className={`w-4 h-4 ${idx < preparationStep ? 'text-emerald-500' : 'text-zinc-700'}`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Output Files */}
      {preparationStep >= preparationSteps.length && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-300">输出文件</h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-4 h-4 text-blue-400" />
                <span className="text-sm text-zinc-200">train.bin</span>
              </div>
              <p className="text-xs text-zinc-500">训练数据二进制文件</p>
            </div>
            <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-4 h-4 text-amber-400" />
                <span className="text-sm text-zinc-200">val.bin</span>
              </div>
              <p className="text-xs text-zinc-500">验证数据二进制文件</p>
            </div>
            <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span className="text-sm text-zinc-200">meta.pkl</span>
              </div>
              <p className="text-xs text-zinc-500">词汇表元数据</p>
            </div>
          </div>
        </div>
      )}

      {/* Next Button */}
      <div className="flex justify-end pt-4">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all"
        >
          下一步：分词器
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
