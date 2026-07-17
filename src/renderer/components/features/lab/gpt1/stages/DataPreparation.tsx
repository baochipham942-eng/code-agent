// ============================================================================
// DataPreparation - 阶段 1: 数据准备
// 展示对话数据格式、数据增强策略、统计信息
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, Plus, Database, BarChart3, FileText } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

// 示例对话数据
const sampleDialogues = [
  { user: '你好', assistant: '你好！很高兴和你聊天。' },
  { user: '今天天气怎么样', assistant: '我无法看到外面的天气，你那里天气如何？' },
  { user: '你叫什么名字', assistant: '我是一个AI助手，你可以叫我小助手。' },
  { user: '给我讲个笑话', assistant: '好的！为什么程序员不喜欢户外？因为有太多的bugs！' },
  { user: '你会做什么', assistant: '我可以回答问题、聊天、讲笑话，还能帮你思考问题。' },
  { user: '你喜欢什么颜色', assistant: '作为AI，我没有真正的偏好，但我觉得蓝色很平静。' },
  { user: '帮我写一首诗', assistant: '春风拂面暖，花开满园香。愿你心情好，快乐每一天。' },
  { user: '今天心情不好', assistant: '我理解你的感受。要不要聊聊发生了什么？我在这里陪你。' },
];

// 数据统计
const dataStats = {
  dialoguePatterns: 27,
  repetitions: 200,
  totalTokens: 129851,
  vocabSize: 280,
};

interface Props {
  onComplete: () => void;
}

export const DataPreparation: React.FC<Props> = ({ onComplete }) => {
  const { t } = useI18n();
  const dp = t.labGpt1.dataPreparation;
  const [customDialogue, setCustomDialogue] = useState({ user: '', assistant: '' });
  const [addedDialogues, setAddedDialogues] = useState<typeof sampleDialogues>([]);

  const handleAddDialogue = () => {
    if (customDialogue.user.trim() && customDialogue.assistant.trim()) {
      setAddedDialogues([...addedDialogues, customDialogue]);
      setCustomDialogue({ user: '', assistant: '' });
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：说明区域 */}
        <div className="space-y-6">
          {/* 概念说明 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400" />
              {dp.whyTitle}
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed mb-3">
              {dp.whyIntro}
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {dp.methodPrefix}<span className="text-emerald-400">{dp.methodHighlight}</span>{dp.methodSuffix}
            </p>
          </div>

          {/* 数据格式说明 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{dp.formatTitle}</h3>
            <div className="bg-zinc-950 rounded-lg p-3 text-sm">
              <div className="flex gap-2 items-start mb-2">
                <span className="text-blue-400 font-medium shrink-0">{dp.formatUserLabel}</span>
                <span className="text-zinc-400">{dp.formatUserExample}</span>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-emerald-400 font-medium shrink-0">{dp.formatAiLabel}</span>
                <span className="text-zinc-400">{dp.formatAiExample}</span>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              {dp.formatHint}
            </p>
          </div>

          {/* 数据增强策略 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{dp.augmentTitle}</h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <div className="flex items-start gap-2">
                <span className="text-xl">📚</span>
                <div>
                  <span className="text-zinc-400 font-medium">{dp.augmentRepeatLabel}</span>
                  {dp.augmentRepeatDesc.replace('{count}', String(dataStats.repetitions))}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xl">🎭</span>
                <div>
                  <span className="text-zinc-400 font-medium">{dp.augmentVarietyLabel}</span>
                  {dp.augmentVarietyDesc}
                </div>
              </div>
            </div>
          </div>

          {/* 数据准备过程 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">📝</span>
              {dp.processTitle}
            </h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800">
                <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs flex items-center justify-center font-bold">1</span>
                <span className="text-zinc-400">{dp.processStep1.replace('{count}', String(dataStats.dialoguePatterns))}</span>
              </div>
              <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800">
                <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs flex items-center justify-center font-bold">2</span>
                <span className="text-zinc-400">{dp.processStep2.replace('{count}', String(dataStats.repetitions))}</span>
              </div>
              <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800">
                <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs flex items-center justify-center font-bold">3</span>
                <span className="text-zinc-400">{dp.processStep3.replace('{count}', (dataStats.totalTokens / 1000).toFixed(0))}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：交互区域 */}
        <div className="space-y-6">
          {/* 数据统计卡片 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/20">
            <h3 className="text-sm font-semibold text-zinc-200 mb-4 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-emerald-400" />
              {dp.statsTitle}
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 rounded-lg bg-zinc-900">
                <div className="text-2xl font-bold text-emerald-400">{dataStats.dialoguePatterns}</div>
                <div className="text-xs text-zinc-500">{dp.statsPatterns}</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900">
                <div className="text-2xl font-bold text-blue-400">{dataStats.totalTokens.toLocaleString()}</div>
                <div className="text-xs text-zinc-500">{dp.statsTokens}</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900">
                <div className="text-2xl font-bold text-amber-400">{dataStats.repetitions}x</div>
                <div className="text-xs text-zinc-500">{dp.statsRepetitions}</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900">
                <div className="text-2xl font-bold text-purple-400">{dataStats.vocabSize}</div>
                <div className="text-xs text-zinc-500">{dp.statsVocab}</div>
              </div>
            </div>
          </div>

          {/* 数据预览 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Database className="w-4 h-4 text-blue-400" />
              {dp.previewTitle}
            </h3>
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {[...sampleDialogues, ...addedDialogues].map((dialogue, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg ${
                    index >= sampleDialogues.length
                      ? 'bg-emerald-500/10 border border-emerald-500/20'
                      : 'bg-zinc-800'
                  }`}
                >
                  <div className="text-xs">
                    <span className="text-blue-400">{dp.previewUserPrefix}</span>
                    <span className="text-zinc-400">{dialogue.user}</span>
                  </div>
                  <div className="text-xs mt-1">
                    <span className="text-emerald-400">{dp.previewAssistantPrefix}</span>
                    <span className="text-zinc-400">{dialogue.assistant}</span>
                  </div>
                  {index >= sampleDialogues.length && (
                    <div className="text-xs text-emerald-400 mt-1">{dp.previewAddedBadge}</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 添加自定义对话 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Plus className="w-4 h-4 text-emerald-400" />
              {dp.addTitle}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">{dp.addUserLabel}</label>
                <input
                  type="text"
                  value={customDialogue.user}
                  onChange={(e) => setCustomDialogue({ ...customDialogue, user: e.target.value })}
                  placeholder={dp.addUserPlaceholder}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-700 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">{dp.addAssistantLabel}</label>
                <input
                  type="text"
                  value={customDialogue.assistant}
                  onChange={(e) => setCustomDialogue({ ...customDialogue, assistant: e.target.value })}
                  placeholder={dp.addAssistantPlaceholder}
                  className="w-full px-3 py-2 rounded-lg bg-zinc-700 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500"
                />
              </div>
              <button
                onClick={handleAddDialogue}
                disabled={!customDialogue.user.trim() || !customDialogue.assistant.trim()}
                className="w-full py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {dp.addButton}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="mt-8 p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {dp.termsTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {dp.terms.map((term) => (
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

      {/* 下一步按钮 */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
        >
          {dp.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
