// ============================================================================
// DataPreparation - 阶段 1: 数据准备
// 展示对话数据格式、数据增强策略、统计信息
// ============================================================================

import React, { useState } from 'react';
import { ChevronRight, Plus, Database, BarChart3, FileText } from 'lucide-react';

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
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400" />
              为什么需要对话数据？
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed mb-3">
              想象你在教一个外星人学中文对话。你会怎么教？
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              最简单的方法：给它听大量的<span className="text-emerald-400">「你说一句，我说一句」</span>的对话，
              让它自己找出规律。AI 学说话也是一样——先"听"足够多的对话，才能学会怎么回答。
            </p>
          </div>

          {/* 数据格式说明 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">对话长什么样？</h3>
            <div className="bg-zinc-950 rounded-lg p-3 text-sm">
              <div className="flex gap-2 items-start mb-2">
                <span className="text-blue-400 font-medium shrink-0">你：</span>
                <span className="text-zinc-300">你好呀</span>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-emerald-400 font-medium shrink-0">AI：</span>
                <span className="text-zinc-300">你好！很高兴和你聊天。</span>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              就是这么简单！一问一答，成千上万组。
            </p>
          </div>

          {/* 数据增强策略 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">怎么让 AI 学得更好？</h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <div className="flex items-start gap-2">
                <span className="text-xl">📚</span>
                <div>
                  <span className="text-zinc-300 font-medium">多听几遍：</span>
                  就像背单词要重复多遍，同样的对话让 AI 看 {dataStats.repetitions} 次，印象更深
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xl">🎭</span>
                <div>
                  <span className="text-zinc-300 font-medium">话题多样：</span>
                  打招呼、聊天气、讲笑话……各种场景都要有
                </div>
              </div>
            </div>
          </div>

          {/* 数据准备过程 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">📝</span>
              数据准备过程（简化版）
            </h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800/50">
                <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs flex items-center justify-center font-bold">1</span>
                <span className="text-zinc-300">收集 {dataStats.dialoguePatterns} 种不同的对话</span>
              </div>
              <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800/50">
                <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs flex items-center justify-center font-bold">2</span>
                <span className="text-zinc-300">每种对话重复 {dataStats.repetitions} 次</span>
              </div>
              <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-800/50">
                <span className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 text-xs flex items-center justify-center font-bold">3</span>
                <span className="text-zinc-300">得到约 {(dataStats.totalTokens / 1000).toFixed(0)}K 字的训练材料</span>
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
              数据统计
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 rounded-lg bg-zinc-900/50">
                <div className="text-2xl font-bold text-emerald-400">{dataStats.dialoguePatterns}</div>
                <div className="text-xs text-zinc-500">对话模式</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900/50">
                <div className="text-2xl font-bold text-blue-400">{dataStats.totalTokens.toLocaleString()}</div>
                <div className="text-xs text-zinc-500">总 Tokens</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900/50">
                <div className="text-2xl font-bold text-amber-400">{dataStats.repetitions}x</div>
                <div className="text-xs text-zinc-500">数据重复</div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900/50">
                <div className="text-2xl font-bold text-purple-400">{dataStats.vocabSize}</div>
                <div className="text-xs text-zinc-500">词汇表大小</div>
              </div>
            </div>
          </div>

          {/* 数据预览 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Database className="w-4 h-4 text-blue-400" />
              训练数据预览
            </h3>
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {[...sampleDialogues, ...addedDialogues].map((dialogue, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg ${
                    index >= sampleDialogues.length
                      ? 'bg-emerald-500/10 border border-emerald-500/20'
                      : 'bg-zinc-800/50'
                  }`}
                >
                  <div className="text-xs">
                    <span className="text-blue-400">用户: </span>
                    <span className="text-zinc-300">{dialogue.user}</span>
                  </div>
                  <div className="text-xs mt-1">
                    <span className="text-emerald-400">助手: </span>
                    <span className="text-zinc-400">{dialogue.assistant}</span>
                  </div>
                  {index >= sampleDialogues.length && (
                    <div className="text-xs text-emerald-400 mt-1">✨ 你添加的</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 添加自定义对话 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Plus className="w-4 h-4 text-emerald-400" />
              添加自定义对话
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">用户输入</label>
                <input
                  type="text"
                  value={customDialogue.user}
                  onChange={(e) => setCustomDialogue({ ...customDialogue, user: e.target.value })}
                  placeholder="输入用户的问题..."
                  className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">助手回复</label>
                <input
                  type="text"
                  value={customDialogue.assistant}
                  onChange={(e) => setCustomDialogue({ ...customDialogue, assistant: e.target.value })}
                  placeholder="输入助手的回复..."
                  className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <button
                onClick={handleAddDialogue}
                disabled={!customDialogue.user.trim() || !customDialogue.assistant.trim()}
                className="w-full py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                添加到训练数据
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 下一步按钮 */}
      <div className="mt-8 flex justify-end">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-500 text-white font-medium hover:bg-blue-600 transition-colors"
        >
          下一步: 分词器
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
