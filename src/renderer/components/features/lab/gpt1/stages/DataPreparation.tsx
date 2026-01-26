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
              什么是训练数据？
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              训练数据是模型学习的"教材"。对于对话模型，我们需要准备大量的
              <span className="text-emerald-400">「用户输入 → 助手回复」</span>
              对，让模型学习如何回应各种问题。
            </p>
          </div>

          {/* 数据格式说明 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">数据格式</h3>
            <div className="font-mono text-xs bg-zinc-950 rounded-lg p-3 text-zinc-300">
              <div className="text-blue-400">用户: </div>
              <div className="text-zinc-500 pl-4">[用户的问题或输入]</div>
              <div className="text-emerald-400 mt-1">助手: </div>
              <div className="text-zinc-500 pl-4">[AI 的回复]</div>
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              每轮对话以换行分隔，模型通过这种格式学习对话的结构。
            </p>
          </div>

          {/* 数据增强策略 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">数据增强策略</h3>
            <div className="space-y-2 text-sm text-zinc-400">
              <div className="flex items-start gap-2">
                <span className="text-amber-400 mt-0.5">•</span>
                <div>
                  <span className="text-zinc-300">重复扩展：</span>
                  将 {dataStats.dialoguePatterns} 种基础对话重复 {dataStats.repetitions} 次，
                  增加数据量
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-amber-400 mt-0.5">•</span>
                <div>
                  <span className="text-zinc-300">多样性覆盖：</span>
                  包含问候、情感、学习、生活等多个对话主题
                </div>
              </div>
            </div>
          </div>

          {/* 代码展示 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <span className="text-emerald-400">{'</>'}</span>
              create_dialogue_corpus.py
            </h3>
            <pre className="font-mono text-xs bg-zinc-950 rounded-lg p-3 overflow-x-auto text-zinc-300">
{`# 基础对话模板
dialogues = [
    ("你好", "你好！很高兴和你聊天。"),
    ("今天天气怎么样", "我无法看到外面的天气..."),
    # ... 更多对话模板
]

# 数据增强：重复 200 次
corpus = ""
for _ in range(200):
    for user, assistant in dialogues:
        corpus += f"用户: {user}\\n"
        corpus += f"助手: {assistant}\\n\\n"

# 保存到文件
with open("dialogue_corpus.txt", "w") as f:
    f.write(corpus)`}
            </pre>
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
