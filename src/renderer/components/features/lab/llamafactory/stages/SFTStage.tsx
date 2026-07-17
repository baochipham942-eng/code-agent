// ============================================================================
// SFTStage - SFT 监督微调
// 数据准备、训练流程、关键超参数、训练监控
// ============================================================================

import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  GraduationCap,
  Database,
  Play,
  Pause,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n/zh';

interface SFTStageProps {
  onComplete: () => void;
  onBack: () => void;
}

// 数据格式示例
// ponytail: example 字段是 SFT 训练数据格式的真实样本（指令/回答对本身），
// 属于"喂给算法的输入数据"而非 UI 文案，故不进 i18n（见协调者判断标准）。
function buildDataFormats(t: Translations) {
  const d = t.labLlamafactory.sft.dataFormats;
  return [
    {
      id: 'alpaca',
      ...d.alpaca,
      example: `{
  "instruction": "翻译成英文",
  "input": "你好，世界",
  "output": "Hello, World"
}`,
    },
    {
      id: 'sharegpt',
      ...d.sharegpt,
      example: `{
  "conversations": [
    {"from": "human", "value": "什么是 AI?"},
    {"from": "gpt", "value": "AI 是人工智能…"},
    {"from": "human", "value": "有什么应用?"},
    {"from": "gpt", "value": "广泛用于…"}
  ]
}`,
    },
    {
      id: 'openai',
      ...d.openai,
      example: `{
  "messages": [
    {"role": "system", "content": "你是助手"},
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好！"}
  ]
}`,
    },
  ];
}

// 超参数配置
function buildHyperparams(t: Translations) {
  const h = t.labLlamafactory.sft.hyperparams;
  return [
    { name: 'Learning Rate', ...h.learningRate, default: '2e-5', range: '1e-6 ~ 5e-4' },
    { name: 'Batch Size', ...h.batchSize, default: '4', range: '1 ~ 128' },
    { name: 'Epochs', ...h.epochs, default: '3', range: '1 ~ 10' },
    { name: 'LoRA Rank', ...h.loraRank, default: '32', range: '8 ~ 128' },
  ];
}

// 数据质量检查项
function buildQualityChecks(t: Translations) {
  const q = t.labLlamafactory.sft.qualityChecks;
  return [
    { ...q[0], status: 'pass' },
    { ...q[1], status: 'pass' },
    { ...q[2], status: 'warn' },
    { ...q[3], status: 'pass' },
  ];
}

export const SFTStage: React.FC<SFTStageProps> = ({ onComplete, onBack }) => {
  const { t } = useI18n();
  const s = t.labLlamafactory.sft;
  const dataFormats = buildDataFormats(t);
  const hyperparams = buildHyperparams(t);
  const qualityChecks = buildQualityChecks(t);
  const [selectedFormat, setSelectedFormat] = useState(0);
  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState(0);
  const [lossHistory, setLossHistory] = useState<number[]>([2.5]);
  const [currentLR, setCurrentLR] = useState(2e-5);
  const [scenario, setScenario] = useState<'normal' | 'overfit'>('normal');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 模拟训练
  const startTraining = () => {
    if (isTraining) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsTraining(false);
      return;
    }

    setIsTraining(true);
    intervalRef.current = setInterval(() => {
      setTrainingProgress((prev) => {
        if (prev >= 100) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setIsTraining(false);
          return 100;
        }
        return prev + 1;
      });

      setLossHistory((prev) => {
        const step = prev.length;
        let newLoss: number;

        if (scenario === 'overfit') {
          // 过拟合：先降后升
          if (step < 30) {
            newLoss = 2.5 - step * 0.05 + Math.random() * 0.1;
          } else {
            newLoss = 1.0 + (step - 30) * 0.02 + Math.random() * 0.1;
          }
        } else {
          // 正常收敛
          newLoss = 2.5 * Math.exp(-step * 0.03) + 0.3 + Math.random() * 0.05;
        }

        return [...prev, Math.max(0.3, newLoss)];
      });
    }, 100);
  };

  const resetTraining = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsTraining(false);
    setTrainingProgress(0);
    setLossHistory([2.5]);
  };

  // 绘制 Loss 曲线
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // 背景网格
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = (i / 5) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Loss 曲线
    if (lossHistory.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = scenario === 'overfit' ? '#f59e0b' : '#22c55e';
      ctx.lineWidth = 2;

      const maxLoss = 3;
      const minLoss = 0;

      lossHistory.forEach((loss, idx) => {
        const x = (idx / 100) * width;
        const y = height - ((loss - minLoss) / (maxLoss - minLoss)) * height;

        if (idx === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
    }
  }, [lossHistory, scenario]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Introduction */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 rounded-lg border border-orange-500/20 p-4">
        <div className="flex items-start gap-3">
          <GraduationCap className="w-5 h-5 text-orange-400 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-zinc-200 mb-2">{s.introTitle}</h3>
            <p className="text-sm text-zinc-400">
              {s.introDescPart1}
              <span className="text-orange-400">{s.introDescHighlight}</span>{s.introDescEnd}
            </p>
          </div>
        </div>
      </div>

      {/* Data Format */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <Database className="w-4 h-4 text-orange-400" />
          {s.dataFormatSectionTitle}
        </h3>
        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="flex gap-2 mb-4">
            {dataFormats.map((format, idx) => (
              <button
                key={format.id}
                onClick={() => setSelectedFormat(idx)}
                className={`
                  px-4 py-2 rounded-lg text-sm transition-all
                  ${selectedFormat === idx
                    ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                    : 'bg-zinc-800 text-zinc-500 border border-zinc-800 hover:border-zinc-600'
                  }
                `}
              >
                {format.name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-zinc-500 mb-2">{dataFormats[selectedFormat].description}</div>
              <pre className="p-3 rounded-lg bg-zinc-950 text-sm text-zinc-400 overflow-x-auto">
                <code>{dataFormats[selectedFormat].example}</code>
              </pre>
            </div>
            <div className="p-3 rounded-lg bg-zinc-800 border border-zinc-800">
              <div className="text-sm font-medium text-zinc-400 mb-2">{s.qualityCheckLabel}</div>
              <ul className="space-y-2">
                {qualityChecks.map((check) => (
                  <li key={check.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {check.status === 'pass' ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-400" />
                      )}
                      <span className="text-sm text-zinc-400">{check.name}</span>
                    </div>
                    <span className="text-xs text-zinc-500">{check.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <div className="text-xs text-blue-400">
              💡 <strong>{s.dataQualityAdviceLabel}</strong>{s.dataQualityAdviceText}
            </div>
          </div>
        </div>
      </div>

      {/* Hyperparameters */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-400">{s.hyperparamsSectionTitle}</h3>
        <div className="grid grid-cols-2 gap-4">
          {hyperparams.map((param) => (
            <div key={param.name} className="p-4 rounded-lg bg-zinc-900 border border-zinc-700">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-medium text-zinc-400">{param.name}</span>
                  <span className="text-xs text-zinc-500 ml-2">{param.zh}</span>
                </div>
                <span className="text-sm text-orange-400 font-mono">{param.default}</span>
              </div>
              <p className="text-xs text-zinc-500 mb-2">{param.description}</p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-600">{s.rangeLabel}{param.range}</span>
                <span className="text-amber-400">💡 {param.tip}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Training Simulation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-400">{s.trainingSimSectionTitle}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setScenario(scenario === 'normal' ? 'overfit' : 'normal');
                resetTraining();
              }}
              className={`
                px-3 py-1.5 rounded-lg text-xs transition-all
                ${scenario === 'overfit'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
                }
              `}
            >
              {scenario === 'overfit' ? s.overfitScenario : s.normalScenario}
            </button>
            <button
              onClick={resetTraining}
              className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              onClick={startTraining}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all
                ${isTraining
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                }
              `}
            >
              {isTraining ? (
                <>
                  <Pause className="w-4 h-4" />
                  {s.pauseButton}
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  {s.startTrainingButton}
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4">
          <div className="grid grid-cols-4 gap-4 mb-4">
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{s.trainingProgressLabel}</div>
              <div className="text-xl font-bold text-orange-400">{trainingProgress}%</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{s.currentLossLabel}</div>
              <div className={`text-xl font-bold ${scenario === 'overfit' && trainingProgress > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {lossHistory[lossHistory.length - 1]?.toFixed(3) || '2.500'}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{s.learningRateLabel}</div>
              <div className="text-xl font-bold text-blue-400">2e-5</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-zinc-500 mb-1">{s.statusLabel}</div>
              <div className={`text-lg font-medium ${
                isTraining ? 'text-amber-400' :
                trainingProgress >= 100 ? 'text-emerald-400' : 'text-zinc-400'
              }`}>
                {isTraining ? s.statusTraining : trainingProgress >= 100 ? s.statusDone : s.statusReady}
              </div>
            </div>
          </div>

          {/* Loss Curve */}
          <div className="p-3 rounded-lg bg-zinc-950">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-500">{s.lossCurveLabel}</span>
              <span className={`text-xs ${scenario === 'overfit' ? 'text-amber-400' : 'text-emerald-400'}`}>
                {scenario === 'overfit' ? s.overfitDetected : s.normalConverging}
              </span>
            </div>
            <canvas
              ref={canvasRef}
              width={600}
              height={150}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-zinc-600 mt-1">
              <span>{s.stepZeroLabel}</span>
              <span>{s.stepHundredLabel}</span>
            </div>
          </div>

          {/* Overfit Warning */}
          {scenario === 'overfit' && trainingProgress > 30 && (
            <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-amber-400">{s.overfitWarningTitle}</div>
                  <p className="text-xs text-zinc-400 mt-1">
                    {s.overfitWarningDetail}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Key Takeaways */}
      <div className="bg-orange-500/5 rounded-lg border border-orange-500/20 p-4">
        <h4 className="text-sm font-medium text-orange-400 mb-2">{s.takeawaysTitle}</h4>
        <ul className="space-y-2 text-sm text-zinc-400">
          {s.takeaways.map((item) => (
            <li key={item.label} className="flex items-start gap-2">
              <span className="text-orange-400">•</span>
              <span><strong className="text-zinc-400">{item.label}</strong>：{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 专有名词 */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <span className="text-blue-400">📖</span>
          {s.glossaryTitle}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {s.glossary.map((term) => (
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

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 border border-zinc-700 transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          {s.backButton}
        </button>
        <button
          onClick={onComplete}
          className="flex items-center gap-2 px-5 py-2.5 bg-orange-500/20 text-orange-400 rounded-lg hover:bg-orange-500/30 border border-orange-500/30 transition-all font-medium"
        >
          {s.nextButton}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
