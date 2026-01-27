// ============================================================================
// InferenceTest - 阶段 5: 推理测试
// 与训练好的模型对话，展示生成过程
// ============================================================================

import React, { useState } from 'react';
import { ChevronLeft, Send, Sparkles, BarChart3, Settings2 } from 'lucide-react';

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
    '这是个有趣的问题，让我想想...',
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
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-400" />
              AI 是怎么「说话」的？
            </h3>
            <div className="space-y-3 text-sm text-zinc-400">
              <p>
                AI 说话不是一次性蹦出一整句，而是
                <span className="text-emerald-400">一个字一个字地往外「挤」</span>：
              </p>
              <ol className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-2xl">👂</span>
                  <span>先「听」你说了什么（比如「你好」）</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🤔</span>
                  <span>想：下一个字应该是什么？可能是「你」「我」「很」...</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🎯</span>
                  <span>选一个最可能的字（比如「你」）</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-2xl">🔄</span>
                  <span>重复这个过程，直到说完一整句话</span>
                </li>
              </ol>
            </div>
          </div>

          {/* 说话风格 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-amber-400" />
              调整 AI 的「性格」
            </h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-400">🎲 创意程度</label>
                  <span className="text-xs font-bold text-emerald-400">
                    {temperature < 0.5 ? '🤖 规规矩矩' : temperature < 1.0 ? '😊 正常发挥' : '🎨 天马行空'}
                  </span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1.5"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-700 cursor-pointer"
                />
                <p className="text-xs text-zinc-600 mt-1">
                  越高越有创意，但也可能说些奇怪的话
                </p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-xs text-zinc-400">🎯 选词范围</label>
                  <span className="text-xs font-bold text-blue-400">前 {topK} 个候选字</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="50"
                  step="1"
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="w-full h-1.5 rounded-lg appearance-none bg-zinc-700 cursor-pointer"
                />
                <p className="text-xs text-zinc-600 mt-1">
                  只从最可能的几个字里选，数字越小越保守
                </p>
              </div>
            </div>
          </div>

          {/* AI 在想什么 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              AI 在想：下一个字说什么？
            </h3>
            {tokenProbs.length > 0 ? (
              <div className="space-y-2">
                {tokenProbs.map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-8 text-sm text-zinc-300 font-bold">{item.token}</span>
                    <div className="flex-1 h-4 bg-zinc-800 rounded overflow-hidden">
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
                  👆 这是 AI 说最后一个字时，各个候选字的「可能性」
                </p>
              </div>
            ) : (
              <div className="text-sm text-zinc-600 text-center py-4">
                发消息后，看看 AI 是怎么「选字」的 🤔
              </div>
            )}
          </div>

          {/* 工作原理图解 */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">AI 说话的过程</h3>
            <div className="space-y-2 text-sm">
              <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <div className="text-blue-300">你说：「你好」</div>
              </div>
              <div className="text-center text-zinc-600">↓ AI 开始想</div>
              <div className="p-2 rounded-lg bg-zinc-800/50">
                <div className="text-zinc-400">想：下一个字...</div>
                <div className="text-xs text-zinc-500 mt-1">
                  「你」30% | 「我」25% | 「很」20% | ...
                </div>
              </div>
              <div className="text-center text-zinc-600">↓ 选概率最高的</div>
              <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="text-emerald-300">AI 说：「你」→「你好」→「你好！」→ ...</div>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：对话测试 */}
        <div className="space-y-6">
          {/* 对话窗口 */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 h-[500px] flex flex-col">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">对话测试</h3>

            {/* 消息列表 */}
            <div className="flex-1 overflow-y-auto space-y-3 mb-4">
              {messages.length === 0 ? (
                <div className="text-center py-8">
                  <Sparkles className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                  <p className="text-sm text-zinc-500">
                    开始和你训练的模型对话吧！
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2 justify-center">
                    {['你好', '给我讲个笑话', '你会做什么'].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => setInput(suggestion)}
                        className="px-3 py-1.5 rounded-full bg-zinc-800/50 border border-zinc-700/50 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
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
                          : 'bg-zinc-800/50 text-zinc-200 rounded-bl-md'
                      }`}
                    >
                      <div className="text-xs text-zinc-500 mb-1">
                        {msg.role === 'user' ? '你' : '助手'}
                      </div>
                      <p className="text-sm">{msg.content}</p>
                    </div>
                  </div>
                ))
              )}

              {/* 生成中指示器 */}
              {isGenerating && (
                <div className="flex justify-start">
                  <div className="px-4 py-2 rounded-2xl bg-zinc-800/50 rounded-bl-md">
                    <div className="text-xs text-zinc-500 mb-1">助手</div>
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
                placeholder="输入消息..."
                disabled={isGenerating}
                className="flex-1 px-4 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
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
              <span className="font-medium">💡 小提示：</span>这个 AI 的「脑容量」很小（只有 ChatGPT 的万分之一），
              只学过几十句对话。它的回答比较简单，但足够让你理解 AI 是怎么「说话」的！
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
            { en: 'Inference', zh: '推理', desc: '使用训练好的模型生成输出的过程，也叫"预测"' },
            { en: 'Temperature', zh: '温度', desc: '控制输出随机性的参数，越高越有创意，越低越保守' },
            { en: 'Top-K Sampling', zh: 'Top-K 采样', desc: '只从概率最高的 K 个候选词中随机选择' },
            { en: 'Top-P Sampling', zh: 'Top-P 采样', desc: '又叫核采样，从累计概率达到 P 的词中选择' },
            { en: 'Probability Distribution', zh: '概率分布', desc: '每个候选词被选中的可能性分布' },
            { en: 'Autoregressive', zh: '自回归', desc: 'GPT 的生成方式：一个字一个字地预测，用前文预测后文' },
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
        <div className="flex items-center gap-2 text-sm text-emerald-400">
          <Sparkles className="w-4 h-4" />
          恭喜！你已完成 GPT-1 全部学习
        </div>
      </div>
    </div>
  );
};
