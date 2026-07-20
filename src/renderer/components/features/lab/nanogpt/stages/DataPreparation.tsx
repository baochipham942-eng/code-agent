// ============================================================================
// DataPreparation - nanoGPT 数据准备阶段
// 用通俗方式展示「准备阅读材料」的过程
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, BookOpen, Play, Check } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

interface DataPreparationProps {
  onComplete: () => void;
}

type DatasetType = 'shakespeare' | 'openwebtext';

// 示例数据 —— 训练语料预览，属于演示数据本身，不进 i18n（翻译会改变演示语义）
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

// 分词演示数据，对应上面语料前几个字符，同样不进 i18n
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

export const DataPreparation: React.FC<DataPreparationProps> = ({ onComplete }) => {
  const { t } = useI18n();
  const dp = t.labNanogpt.dataPreparation;
  const datasetStats = {
    shakespeare: {
      totalChars: dp.shakespeareStatTotalChars,
      uniqueChars: dp.shakespeareStatUniqueChars,
      trainSize: dp.shakespeareStatTrainSize,
      valSize: dp.shakespeareStatValSize,
      vocabType: dp.shakespeareStatVocabType,
    },
    openwebtext: {
      totalTokens: dp.openwebtextStatTotalTokens,
      uniqueTokens: dp.openwebtextStatUniqueTokens,
      trainSize: dp.openwebtextStatTrainSize,
      valSize: dp.openwebtextStatValSize,
      vocabType: dp.openwebtextStatVocabType,
    },
  };
  const [selectedDataset, setSelectedDataset] = useState<DatasetType>('shakespeare');
  const [preparationStep, setPreparationStep] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const preparationSteps = dp.preparationSteps.map((step, id) => ({ id, ...step }));

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
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{dp.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {dp.introBodyPre}
              <span className="text-purple-400">{dp.introBodyHighlight}</span>
              {dp.introBodyPost}
            </p>
          </div>
        </div>
      </div>

      {/* Dataset Selection */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{dp.datasetSelectionLabel}</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Shakespeare */}
          <button
            onClick={() => setSelectedDataset('shakespeare')}
            className={`p-4 rounded-lg border text-left transition-all ${
              selectedDataset === 'shakespeare'
                ? 'bg-emerald-500/10 border-emerald-500/50'
                : 'bg-zinc-800 border-zinc-700 hover:border-zinc-600'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">📚</span>
              <span className={`font-medium ${selectedDataset === 'shakespeare' ? 'text-emerald-400' : 'text-zinc-200'}`}>
                {dp.shakespeareName}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">{dp.shakespeareBadge}</span>
            </div>
            <p className="text-xs text-zinc-500">
              {dp.shakespeareDesc}
            </p>
            <p className="text-xs text-emerald-400/70 mt-1">
              {dp.shakespeareHighlight}
            </p>
          </button>

          {/* OpenWebText */}
          <button
            onClick={() => setSelectedDataset('openwebtext')}
            className={`p-4 rounded-lg border text-left transition-all ${
              selectedDataset === 'openwebtext'
                ? 'bg-emerald-500/10 border-emerald-500/50'
                : 'bg-zinc-800 border-zinc-700 hover:border-zinc-600'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">🌐</span>
              <span className={`font-medium ${selectedDataset === 'openwebtext' ? 'text-emerald-400' : 'text-zinc-200'}`}>
                {dp.openwebtextName}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">{dp.openwebtextBadge}</span>
            </div>
            <p className="text-xs text-zinc-500">
              {dp.openwebtextDesc}
            </p>
            <p className="text-xs text-amber-400/70 mt-1">
              {dp.openwebtextHighlight}
            </p>
          </button>
        </div>
      </div>

      {/* Data Preview */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{dp.previewLabel}</h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📄</span>
            <span className="text-xs text-zinc-500">
              {selectedDataset === 'shakespeare' ? dp.previewShakespeareCaption : dp.previewOpenwebtextCaption}
            </span>
          </div>
          <pre className="text-sm text-zinc-400 whitespace-pre-wrap bg-zinc-950/50 p-3 rounded border border-zinc-700 max-h-40 overflow-auto">
            {shakespearePreview}
          </pre>
          <p className="text-xs text-zinc-500 mt-2">
            {dp.previewHint}
          </p>
        </div>
      </div>

      {/* Dataset Statistics */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{dp.statsLabel}</h3>
        <div className="grid grid-cols-5 gap-3">
          {Object.entries(datasetStats[selectedDataset]).map(([key, value]) => (
            <div key={key} className="bg-zinc-800 rounded-lg p-3 border border-zinc-800">
              <div className="text-xs text-zinc-500 mb-1">
                {key === 'totalChars' && dp.statTotalChars}
                {key === 'totalTokens' && dp.statTotalTokens}
                {key === 'uniqueChars' && dp.statUniqueChars}
                {key === 'uniqueTokens' && dp.statUniqueTokens}
                {key === 'trainSize' && dp.statTrainSize}
                {key === 'valSize' && dp.statValSize}
                {key === 'vocabType' && dp.statVocabType}
              </div>
              <div className="text-sm font-medium text-emerald-400">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Encoding Visualization */}
      {selectedDataset === 'shakespeare' && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-400">{dp.tokenEncodingLabel}</h3>
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
            <p className="text-xs text-zinc-500 mb-3">
              {dp.tokenEncodingHint}
            </p>
            <div className="flex flex-wrap gap-2">
              {tokenizedPreview.shakespeare.map((token, idx) => (
                <div
                  key={idx}
                  className="group relative flex flex-col items-center"
                >
                  <div className="px-3 py-2 bg-zinc-800 rounded-lg text-base text-zinc-400 border border-zinc-700">
                    {token.char === '\n' ? dp.tokenEncodingNewline : token.char === ' ' ? dp.tokenEncodingSpace : token.char}
                  </div>
                  <div className="text-xs text-emerald-400 mt-1 font-bold">#{token.id}</div>
                </div>
              ))}
              <div className="px-3 py-2 text-zinc-500 flex items-center">...</div>
            </div>
            <div className="mt-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="text-xs text-emerald-400">
                {/* ponytail: 「第」是24号「一」是47号 直接对应上面 tokenizedPreview 语料数据，随内容保留中文不迁移 */}
                💡 就像给班级同学编学号一样！「第」是24号，「一」是47号…
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preparation Pipeline */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">{dp.preparationLabel}</h3>
          <button
            onClick={runPreparation}
            disabled={isProcessing || preparationStep >= preparationSteps.length}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
              isProcessing || preparationStep >= preparationSteps.length
                ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
            }`}
          >
            <Play className="w-4 h-4" />
            {preparationStep >= preparationSteps.length ? dp.runButtonReady : dp.runButtonStart}
          </button>
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
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
                          : 'bg-zinc-800 border-zinc-700'
                    }`}
                  >
                    {idx < preparationStep ? <Check className="w-5 h-5 text-emerald-400" /> : step.title.slice(0, 2)}
                  </div>
                  <span className="text-[10px] text-zinc-500 text-center w-16">{step.desc}</span>
                </div>
                {idx < preparationSteps.length - 1 && (
                  <ChevronRight className={`w-4 h-4 ${idx < preparationStep ? 'text-emerald-500' : 'text-zinc-600'}`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Output Files */}
      {preparationStep >= preparationSteps.length && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-400">{dp.outputFilesLabel}</h3>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📗</span>
                <span className="text-sm text-zinc-200">{dp.outputCard1Title}</span>
              </div>
              <p className="text-xs text-zinc-500">{dp.outputCard1Desc}</p>
            </div>
            <div className="bg-blue-500/10 rounded-lg p-3 border border-blue-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📘</span>
                <span className="text-sm text-zinc-200">{dp.outputCard2Title}</span>
              </div>
              <p className="text-xs text-zinc-500">{dp.outputCard2Desc}</p>
            </div>
            <div className="bg-purple-500/10 rounded-lg p-3 border border-purple-500/20">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📒</span>
                <span className="text-sm text-zinc-200">{dp.outputCard3Title}</span>
              </div>
              <p className="text-xs text-zinc-500">{dp.outputCard3Desc}</p>
            </div>
          </div>
          <p className="text-xs text-emerald-400 text-center">
            {dp.outputFooter}
          </p>
        </div>
      )}

      {/* 专有名词解释 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {dp.glossaryLabel}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {dp.glossary.map((term) => (
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

      {/* Next Button */}
      <div className="flex justify-end pt-4">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 border border-blue-500/30 transition-all font-medium"
        >
          {dp.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
