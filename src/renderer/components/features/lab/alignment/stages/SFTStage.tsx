// ============================================================================
// SFTStage - 监督微调阶段
// 展示指令数据格式、训练流程和效果对比
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  FileText,
  Code,
  Play,
  Pause,
  RotateCcw,
  MessageSquare,
  User,
  Bot,
} from 'lucide-react';

interface SFTStageProps {
  onComplete: () => void;
}

// 指令数据集示例
const instructionExamples = [
  {
    instruction: '将以下英文翻译成中文',
    input: 'Hello, how are you today?',
    output: '你好，你今天怎么样？',
  },
  {
    instruction: '写一首关于春天的诗',
    input: '',
    output: '春风拂面暖阳照，\n桃花盛开蝶飞舞。\n万物复苏生机显，\n大地换上新衣裳。',
  },
  {
    instruction: '解释什么是机器学习',
    input: '',
    output:
      '机器学习是人工智能的一个分支，它使计算机能够从数据中学习模式，而无需显式编程。通过分析大量数据，机器学习算法可以自动改进其性能。',
  },
  {
    instruction: '将下面的句子改写成更礼貌的形式',
    input: '把文件给我',
    output: '请问您方便把文件发给我吗？谢谢！',
  },
];

// 对话模板格式
const templateFormats = {
  alpaca: `Below is an instruction that describes a task. Write a response that appropriately completes the request.

### Instruction:
{instruction}

### Input:
{input}

### Response:
{output}`,
  chatml: `<|im_start|>system
You are a helpful assistant.
<|im_end|>
<|im_start|>user
{instruction}
{input}
<|im_end|>
<|im_start|>assistant
{output}
<|im_end|>`,
  llama2: `[INST] <<SYS>>
You are a helpful assistant.
<</SYS>>

{instruction}
{input} [/INST] {output}`,
};

// 模拟训练前后对比
const beforeAfterExamples = [
  {
    prompt: '写一个 Python 函数计算阶乘',
    before: `def factorial(n):
    if n == 0:
        return 1
    else:
        return n * factorial(n-1)

这是一个递归函数但是没有处理负数情况也没有文档字符串而且格式不太好看`,
    after: `def factorial(n: int) -> int:
    """
    计算非负整数的阶乘。

    Args:
        n: 非负整数

    Returns:
        n 的阶乘值

    Raises:
        ValueError: 如果 n 为负数
    """
    if n < 0:
        raise ValueError("阶乘只能计算非负整数")
    if n == 0 or n == 1:
        return 1
    return n * factorial(n - 1)`,
  },
];

export const SFTStage: React.FC<SFTStageProps> = ({ onComplete }) => {
  const [selectedExample, setSelectedExample] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState<keyof typeof templateFormats>('alpaca');
  const [isTraining, setIsTraining] = useState(false);
  const [trainingStep, setTrainingStep] = useState(0);
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 模拟训练
  const toggleTraining = () => {
    if (isTraining) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsTraining(false);
    } else {
      setIsTraining(true);
      intervalRef.current = setInterval(() => {
        setTrainingStep((prev) => {
          const newStep = prev + 1;
          const loss = 2.5 * Math.exp(-newStep / 300) + 0.5 + Math.random() * 0.1;
          setLossHistory((h) => [...h.slice(-50), loss]);

          if (newStep >= 500) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setIsTraining(false);
            return 500;
          }
          return newStep;
        });
      }, 50);
    }
  };

  const resetTraining = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsTraining(false);
    setTrainingStep(0);
    setLossHistory([]);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // 绘制 loss 曲线
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || lossHistory.length < 2) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = 'rgba(24, 24, 27, 0.5)';
    ctx.fillRect(0, 0, width, height);

    const maxLoss = Math.max(...lossHistory) + 0.2;
    const minLoss = Math.min(...lossHistory) - 0.2;

    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    lossHistory.forEach((loss, i) => {
      const x = (i / (lossHistory.length - 1)) * width;
      const y = height - ((loss - minLoss) / (maxLoss - minLoss)) * height * 0.8 - height * 0.1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [lossHistory]);

  const currentExample = instructionExamples[selectedExample];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 rounded-lg border border-purple-500/20 p-4">
        <div className="flex items-start gap-3">
          <FileText className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-1">监督微调 (SFT)</h3>
            <p className="text-xs text-zinc-400">
              SFT 使用人工标注的「指令-响应」对来训练模型。这是让模型学会遵循人类指令的第一步，
              也是 RLHF 的前置条件。数据质量直接决定模型的指令遵循能力。
            </p>
          </div>
        </div>
      </div>

      {/* Instruction Dataset */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">指令数据集示例</h3>
        <div className="flex gap-2 mb-3">
          {instructionExamples.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setSelectedExample(idx)}
              className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                selectedExample === idx
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : 'bg-zinc-800/30 text-zinc-500 border border-zinc-700/30 hover:border-zinc-600'
              }`}
            >
              示例 {idx + 1}
            </button>
          ))}
        </div>

        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4 space-y-3">
          {/* Instruction */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">instruction</span>
            </div>
            <p className="text-sm text-zinc-300">{currentExample.instruction}</p>
          </div>

          {/* Input (if exists) */}
          {currentExample.input && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">input</span>
              </div>
              <p className="text-sm text-zinc-400">{currentExample.input}</p>
            </div>
          )}

          {/* Output */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">output</span>
            </div>
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap">{currentExample.output}</pre>
          </div>
        </div>
      </div>

      {/* Template Format */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">对话模板格式</h3>
        <div className="flex gap-2 mb-3">
          {(Object.keys(templateFormats) as (keyof typeof templateFormats)[]).map((format) => (
            <button
              key={format}
              onClick={() => setSelectedTemplate(format)}
              className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                selectedTemplate === format
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : 'bg-zinc-800/30 text-zinc-500 border border-zinc-700/30 hover:border-zinc-600'
              }`}
            >
              {format.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="bg-zinc-950/50 rounded-lg border border-zinc-800/50 p-4">
          <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap overflow-auto max-h-48">
            {templateFormats[selectedTemplate]
              .replace('{instruction}', currentExample.instruction)
              .replace('{input}', currentExample.input || '(无)')
              .replace('{output}', currentExample.output)}
          </pre>
        </div>
      </div>

      {/* Training Simulation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">SFT 训练过程</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 border border-zinc-700/50"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={toggleTraining}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                isTraining
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
              }`}
            >
              {isTraining ? (
                <>
                  <Pause className="w-4 h-4" />
                  暂停
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  模拟训练
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800/50 p-4">
          <canvas ref={canvasRef} width={700} height={120} className="w-full h-28 rounded-lg" />

          <div className="mt-3 pt-3 border-t border-zinc-800/50 grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-zinc-500">训练步数</div>
              <div className="text-lg font-mono text-zinc-300">{trainingStep} / 500</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">当前 Loss</div>
              <div className="text-lg font-mono text-purple-400">
                {lossHistory[lossHistory.length - 1]?.toFixed(4) || '-.----'}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">进度</div>
              <div className="text-lg font-mono text-zinc-300">{((trainingStep / 500) * 100).toFixed(0)}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Before/After Comparison */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">训练前后对比</h3>
        <div className="grid grid-cols-2 gap-4">
          {/* Before SFT */}
          <div className="bg-zinc-800/30 rounded-lg border border-zinc-700/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-zinc-500" />
              <span className="text-sm font-medium text-zinc-400">预训练模型（SFT 前）</span>
            </div>
            <div className="bg-zinc-950/50 p-3 rounded text-xs font-mono text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">
              {beforeAfterExamples[0].before}
            </div>
            <div className="mt-2 text-xs text-red-400">❌ 格式混乱，缺少文档和错误处理</div>
          </div>

          {/* After SFT */}
          <div className="bg-purple-500/5 rounded-lg border border-purple-500/30 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-purple-400">SFT 后</span>
            </div>
            <div className="bg-zinc-950/50 p-3 rounded text-xs font-mono text-emerald-400 whitespace-pre-wrap max-h-48 overflow-auto">
              {beforeAfterExamples[0].after}
            </div>
            <div className="mt-2 text-xs text-emerald-400">✓ 规范的代码、完整文档、错误处理</div>
          </div>
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-purple-500/5 rounded-lg border border-purple-500/20 p-4">
        <h4 className="text-sm font-medium text-purple-400 mb-2">SFT 要点</h4>
        <ul className="space-y-1 text-xs text-zinc-400">
          <li>
            • <strong className="text-zinc-300">数据质量至关重要</strong>：高质量的指令-响应对决定模型表现
          </li>
          <li>
            • <strong className="text-zinc-300">模板格式统一</strong>：训练和推理时使用相同的对话模板
          </li>
          <li>
            • <strong className="text-zinc-300">学习率要小</strong>：通常使用预训练 LR 的 1/10 ~ 1/100
          </li>
          <li>
            • <strong className="text-zinc-300">是 RLHF 的基础</strong>：SFT 模型是后续 PPO 训练的起点
          </li>
        </ul>
      </div>

      {/* Navigation */}
      <div className="flex justify-end pt-4">
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-4 py-2 bg-purple-500/20 text-purple-400 rounded-lg hover:bg-purple-500/30 border border-purple-500/30 transition-all"
        >
          下一步：奖励模型
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
