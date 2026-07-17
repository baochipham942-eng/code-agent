// ============================================================================
// InferenceTest - 阶段 5: 推理测试
// 与训练好的模型对话，展示生成过程
// ============================================================================

import React, { useState } from 'react';
import { ChevronLeft, Send, Sparkles, BarChart3, Settings2 } from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';

// 模拟回复生成
const simulatedResponses: Record<string, string[]> = {
  '你好': ['你好！很高兴和你聊天。', '你好！有什么我可以帮你的吗？', '你好啊！今天过得怎么样？'],
  '今天天气怎么样': ['我无法看到外面的天气，你那里天气如何？', '作为AI，我没办法观察天气，不过希望你那边阳光明媚！'],
  '你叫什么名字': ['我是一个AI助手，你可以叫我小助手。', '我是你的AI对话伙伴，很高兴认识你！'],
  '给我讲个笑话': ['好的！为什么程序员不喜欢户外？因为有太多的bugs！', '程序员最喜欢的饮料是什么？Java咖啡！'],
  '你会做什么': ['我可以回答问题、聊天、讲笑话，还能帮你思考问题。', '我能和你聊天，回答问题，给你一些建议。'],
  '再见': ['再见！希望我们的对话让你开心。', '拜拜！期待下次聊天！'],
};

// 获取模拟回复
const getSimulatedResponse = (input: string, temperature: number): string => {
  // 查找最匹配的问题
  const normalizedInput = input.toLowerCase().trim();
  for (const [key, responses] of Object.entries(simulatedResponses)) {
    if (normalizedInput.includes(key) || key.includes(normalizedInput)) {
      // 根据温度选择回复的随机性
      if (temperature > 0.7) {
        return responses[Math.floor(Math.random() * responses.length)];
      }
      return responses[0];
    }
  }
  // 默认回复
  const defaults = [
    '这是个有趣的问题，让我想想…',
    '我理解你的意思，不过作为一个小模型，我的知识有限。',
    '嗯，这个话题很有意思！你能告诉我更多吗？',
  ];
  return temperature > 0.5 ? defaults[Math.floor(Math.random() * defaults.length)] : defaults[0];
};

// 模拟 Token 概率
const generateTokenProbabilities = (): { token: string; prob: number }[] => {
  const tokens = ['你', '好', '我', '是', '的', '很', '高', '兴', '和', '聊', '天', '！', '？', '。'];
  return tokens
    .map((token) => ({ token, prob: Math.random() }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 8)
    .map((t, i) => ({ ...t, prob: t.prob / (i + 1) })); // 归一化让概率看起来更真实
};

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  onBack: () => void;
}

export const InferenceTest: React.FC<Props> = ({ onBack }) => {
  const { t } = useI18n();
  const it = t.labGpt1.inferenceTest;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [temperature, setTemperature] = useState(0.8);
  const [topK, setTopK] = useState(20);
  const [tokenProbs, setTokenProbs] = useState<{ token: string; prob: number }[]>([]);

  const handleSend = async () => {
    if (!input.trim() || isGenerating) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setIsGenerating(true);
    setTokenProbs([]);

    // 模拟生成延迟
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

    // 生成回复
    const response = getSimulatedResponse(userMessage, temperature);
    setMessages((prev) => [...prev, { role: 'assistant', content: response }]);

    // 生成 token 概率可视化
    setTokenProbs(generateTokenProbabilities());
    setIsGenerating(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：说明和配置 */}
        <div className="space-y-6">
          {/* 概念说明 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-400" />
              {it.howTitle}
            </h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <p>
                {it.howPrefix}
                <span className="text-emerald-400">{it.howHighlight}</span>{it.howSuffix}
              </p>
              <ol className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-2xl">👂</span>
                  <span>{it.howStep1}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🤔</span>
                  <span>{it.howStep2}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🎯</span>
                  <span>{it.howStep3}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🔄</span>
                  <span>{it.howStep4}</span>
                </li>
              </ol>
            </div>
          </div>

          {/* 说话风格 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-amber-400" />
              {it.styleTitle}
            </h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-400">{it.temperatureLabel}</label>
                  <span className="text-xs font-bold text-emerald-400">
                    {temperature < 0.5 ? it.temperatureLow : temperature < 1.0 ? it.temperatureMid : it.temperatureHigh}
                  </span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1.5"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-600 cursor-pointer"
                />
                <p className="text-xs text-zinc-600 mt-1">
                  {it.temperatureHint}
                </p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-400">{it.topKLabel}</label>
                  <span className="text-xs font-bold text-blue-400">{it.topKValue.replace('{count}', String(topK))}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="50"
                  step="1"
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-600 cursor-pointer"
                />
                <p className="text-xs text-zinc-600 mt-1">
                  {it.topKHint}
                </p>
              </div>
            </div>
          </div>

          {/* AI 在想什么 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              {it.probsTitle}
            </h3>
            {tokenProbs.length > 0 ? (
              <div className="space-y-2">
                {tokenProbs.map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-8 text-sm text-zinc-400 font-bold">{item.token}</span>
                    <div className="flex-1 h-4 bg-zinc-700 rounded overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300"
                        style={{ width: `${item.prob * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-zinc-500 w-12 text-right">
                      {(item.prob * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
                <p className="text-xs text-zinc-600 mt-2">
                  {it.probsHint}
                </p>
              </div>
            ) : (
              <div className="text-sm text-zinc-600 text-center py-4">
                {it.probsEmpty}
              </div>
            )}
          </div>

          {/* 工作原理图解 */}
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{it.processTitle}</h3>
            <div className="space-y-2 text-sm">
              <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <div className="text-blue-300">{it.processYouSay}</div>
              </div>
              <div className="text-center text-zinc-600">{it.processThinkArrow}</div>
              <div className="p-2 rounded-lg bg-zinc-800">
                <div className="text-zinc-400">{it.processThinking}</div>
                <div className="text-xs text-zinc-500 mt-1">
                  {it.processCandidates}
                </div>
              </div>
              <div className="text-center text-zinc-600">{it.processPickArrow}</div>
              <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="text-emerald-300">{it.processResult}</div>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：对话测试 */}
        <div className="space-y-6">
          {/* 对话窗口 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 h-[500px] flex flex-col">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">{it.chatTitle}</h3>

            {/* 消息列表 */}
            <div className="flex-1 overflow-y-auto space-y-3 mb-4">
              {messages.length === 0 ? (
                <div className="text-center py-8">
                  <Sparkles className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                  <p className="text-sm text-zinc-500">
                    {it.chatEmptyHint}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2 justify-center">
                    {['你好', '给我讲个笑话', '你会做什么'].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => setInput(suggestion)}
                        className="px-3 py-1.5 rounded-full bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] px-4 py-2 rounded-2xl ${
                        msg.role === 'user'
                          ? 'bg-blue-500/20 text-blue-100 rounded-br-md'
                          : 'bg-zinc-800 text-zinc-200 rounded-bl-md'
                      }`}
                    >
                      <div className="text-xs text-zinc-500 mb-1">
                        {msg.role === 'user' ? it.roleUser : it.roleAssistant}
                      </div>
                      <p className="text-sm">{msg.content}</p>
                    </div>
                  </div>
                ))
              )}

              {/* 生成中指示器 */}
              {isGenerating && (
                <div className="flex justify-start">
                  <div className="px-4 py-2 rounded-2xl bg-zinc-800 rounded-bl-md">
                    <div className="text-xs text-zinc-500 mb-1">{it.roleAssistant}</div>
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-zinc-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-zinc-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-zinc-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 输入框 */}
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={it.inputPlaceholder}
                disabled={isGenerating}
                className="flex-1 px-4 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-zinc-500 disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isGenerating}
                className="px-4 py-2 rounded-lg bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 提示 */}
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <p className="text-sm text-amber-200">
              <span className="font-medium">{it.tipPrefix}</span>{it.tipBody}
            </p>
          </div>
        </div>
      </div>

      {/* 专有名词解释 */}
      <div className="mt-8 p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {it.termsTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {it.terms.map((term) => (
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
          {it.backButton}
        </button>
        <div className="flex items-center gap-2 text-sm text-emerald-400">
          <Sparkles className="w-4 h-4" />
          {it.completeLabel}
        </div>
      </div>
    </div>
  );
};
