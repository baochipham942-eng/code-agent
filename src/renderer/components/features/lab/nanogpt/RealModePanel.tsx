// ============================================================================
// RealModePanel - nanoGPT 真实训练模式面板
// 支持下载项目、配置训练、执行真实 Python 训练
// ============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import {
  Download,
  Play,
  Square,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Terminal,
  Cpu,
  HardDrive,
  FolderOpen,
  Settings,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { IPC_CHANNELS } from '../../../../../shared/ipc';
import type {
  PythonEnvStatus,
  LabProjectStatus,
  TrainingProgressEvent,
} from '../../../../../shared/types/lab';

type TrainingMode = 'pretrain' | 'finetune';
type InitFrom = 'scratch' | 'gpt2' | 'gpt2-medium';

interface TrainingConfig {
  mode: TrainingMode;
  initFrom: InitFrom;
  dataset: 'shakespeare_char' | 'openwebtext';
  batchSize: number;
  learningRate: number;
  maxIters: number;
  device: 'cpu' | 'mps' | 'cuda';
}

const defaultConfig: TrainingConfig = {
  mode: 'finetune',
  initFrom: 'gpt2',
  dataset: 'shakespeare_char',
  batchSize: 12,
  learningRate: 3e-5,
  maxIters: 5000,
  device: 'mps',
};

export const RealModePanel: React.FC = () => {
  // 状态
  const [pythonEnv, setPythonEnv] = useState<PythonEnvStatus | null>(null);
  const [projectStatus, setProjectStatus] = useState<LabProjectStatus | null>(null);
  const [config, setConfig] = useState<TrainingConfig>(defaultConfig);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [trainingLogs, setTrainingLogs] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [currentLoss, setCurrentLoss] = useState<number | null>(null);

  // 检查 Python 环境
  const checkPythonEnv = useCallback(async () => {
    const result = await window.electronAPI?.invoke(IPC_CHANNELS.LAB_CHECK_PYTHON_ENV);
    setPythonEnv(result ?? null);
  }, []);

  // 获取项目状态
  const getProjectStatus = useCallback(async () => {
    const result = await window.electronAPI?.invoke(IPC_CHANNELS.LAB_GET_PROJECT_STATUS, 'nanogpt');
    setProjectStatus(result ?? null);
  }, []);

  // 下载项目
  const downloadProject = useCallback(async () => {
    setIsDownloading(true);
    setTrainingLogs((prev) => [...prev, '📦 开始下载 nanoGPT 项目...']);

    const result = await window.electronAPI?.invoke(IPC_CHANNELS.LAB_DOWNLOAD_PROJECT, {
      projectType: 'nanogpt',
    });

    if (result?.success) {
      setTrainingLogs((prev) => [...prev, '✅ 项目下载完成']);
      await getProjectStatus();
    } else {
      setTrainingLogs((prev) => [...prev, `❌ 下载失败: ${result?.error || '未知错误'}`]);
    }

    setIsDownloading(false);
  }, [getProjectStatus]);

  // 开始训练
  const startTraining = useCallback(async () => {
    setIsTraining(true);
    setTrainingLogs((prev) => [...prev, `🚀 开始${config.mode === 'finetune' ? '微调' : '预训练'}...`]);
    setCurrentStep(0);
    setCurrentLoss(null);

    const trainingConfig = {
      batchSize: config.batchSize,
      learningRate: config.learningRate,
      maxIters: config.maxIters,
      evalInterval: 250,
      device: config.device,
      // nanoGPT 特有配置
      initFrom: config.initFrom,
      dataset: config.dataset,
    };

    const result = await window.electronAPI?.invoke(IPC_CHANNELS.LAB_START_TRAINING, {
      projectType: 'nanogpt',
      config: trainingConfig,
    });

    if (!result?.success) {
      setTrainingLogs((prev) => [...prev, `❌ 训练启动失败: ${result?.error || '未知错误'}`]);
      setIsTraining(false);
    }
  }, [config]);

  // 停止训练
  const stopTraining = useCallback(async () => {
    setTrainingLogs((prev) => [...prev, '⏹️ 正在停止训练...']);
    await window.electronAPI?.invoke(IPC_CHANNELS.LAB_STOP_TRAINING, 'nanogpt');
    setIsTraining(false);
    setTrainingLogs((prev) => [...prev, '✅ 训练已停止']);
  }, []);

  // 监听训练进度事件
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
      IPC_CHANNELS.LAB_TRAINING_PROGRESS,
      (event: TrainingProgressEvent) => {
        if (event.projectType !== 'nanogpt') return;

        if (event.type === 'log') {
          if (event.message) {
            setTrainingLogs((prev) => [...prev.slice(-100), event.message!]);
          }
        } else if (event.type === 'progress') {
          setCurrentStep(event.step ?? 0);
          setCurrentLoss(event.loss ?? null);
        } else if (event.type === 'complete') {
          setIsTraining(false);
          setTrainingLogs((prev) => [...prev, '🎉 训练完成！']);
        } else if (event.type === 'error') {
          setIsTraining(false);
          setTrainingLogs((prev) => [...prev, `❌ 训练错误: ${event.message}`]);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  // 初始化
  useEffect(() => {
    checkPythonEnv();
    getProjectStatus();
  }, [checkPythonEnv, getProjectStatus]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-6">
      <div className="max-w-5xl mx-auto w-full space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-200">nanoGPT 真实训练</h2>
            <p className="text-sm text-zinc-500">克隆 Karpathy 的 nanoGPT，执行真实的模型训练</p>
          </div>
          <button
            onClick={() => {
              checkPythonEnv();
              getProjectStatus();
            }}
            className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Environment Status */}
        <div className="grid grid-cols-2 gap-4">
          {/* Python Environment */}
          <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Terminal className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">Python 环境</span>
            </div>
            {pythonEnv ? (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">Python</span>
                  <span className={pythonEnv.pythonInstalled ? 'text-emerald-400' : 'text-red-400'}>
                    {pythonEnv.pythonInstalled ? pythonEnv.pythonVersion : '未安装'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">PyTorch</span>
                  <span className={pythonEnv.pytorchInstalled ? 'text-emerald-400' : 'text-red-400'}>
                    {pythonEnv.pytorchInstalled ? pythonEnv.pytorchVersion : '未安装'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">tiktoken</span>
                  <span className={pythonEnv.sentencepieceInstalled ? 'text-emerald-400' : 'text-amber-400'}>
                    {pythonEnv.sentencepieceInstalled ? '已安装' : '需要安装'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                检测中...
              </div>
            )}
          </div>

          {/* Project Status */}
          <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <FolderOpen className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">项目状态</span>
            </div>
            {projectStatus ? (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">已下载</span>
                  {projectStatus.downloaded ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-zinc-500" />
                  )}
                </div>
                {projectStatus.downloaded && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500">路径</span>
                      <span className="text-zinc-400 truncate max-w-[200px]" title={projectStatus.projectPath || ''}>
                        {projectStatus.projectPath?.split('/').slice(-2).join('/')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500">已训练模型</span>
                      {projectStatus.hasTrainedModel ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <span className="text-zinc-500">无</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                检测中...
              </div>
            )}
          </div>
        </div>

        {/* Download Button */}
        {!projectStatus?.downloaded && (
          <button
            onClick={downloadProject}
            disabled={isDownloading}
            className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm transition-all ${
              isDownloading
                ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
            }`}
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                下载中...
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                下载 nanoGPT 项目
              </>
            )}
          </button>
        )}

        {/* Training Configuration */}
        {projectStatus?.downloaded && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">训练配置</span>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Training Mode */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">训练模式</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfig((c) => ({ ...c, mode: 'finetune', initFrom: 'gpt2' }))}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs transition-all ${
                      config.mode === 'finetune'
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
                    }`}
                  >
                    微调
                  </button>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, mode: 'pretrain', initFrom: 'scratch' }))}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs transition-all ${
                      config.mode === 'pretrain'
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
                    }`}
                  >
                    预训练
                  </button>
                </div>
              </div>

              {/* Init From */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">初始化来源</label>
                <select
                  value={config.initFrom}
                  onChange={(e) => setConfig((c) => ({ ...c, initFrom: e.target.value as InitFrom }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                >
                  <option value="scratch">从头训练</option>
                  <option value="gpt2">GPT-2 (124M)</option>
                  <option value="gpt2-medium">GPT-2 Medium (350M)</option>
                </select>
              </div>

              {/* Device */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">设备</label>
                <select
                  value={config.device}
                  onChange={(e) => setConfig((c) => ({ ...c, device: e.target.value as 'cpu' | 'mps' | 'cuda' }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                >
                  <option value="cpu">CPU</option>
                  <option value="mps">MPS (Apple Silicon)</option>
                  <option value="cuda">CUDA (NVIDIA)</option>
                </select>
              </div>

              {/* Batch Size */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">Batch Size</label>
                <input
                  type="number"
                  value={config.batchSize}
                  onChange={(e) => setConfig((c) => ({ ...c, batchSize: parseInt(e.target.value) || 12 }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                />
              </div>

              {/* Learning Rate */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">Learning Rate</label>
                <input
                  type="text"
                  value={config.learningRate.toExponential(0)}
                  onChange={(e) => setConfig((c) => ({ ...c, learningRate: parseFloat(e.target.value) || 3e-5 }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                />
              </div>

              {/* Max Iters */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">Max Iterations</label>
                <input
                  type="number"
                  value={config.maxIters}
                  onChange={(e) => setConfig((c) => ({ ...c, maxIters: parseInt(e.target.value) || 5000 }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                />
              </div>
            </div>

            {/* Training Controls */}
            <div className="flex gap-3">
              <button
                onClick={isTraining ? stopTraining : startTraining}
                disabled={!pythonEnv?.pytorchInstalled}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm transition-all ${
                  !pythonEnv?.pytorchInstalled
                    ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
                    : isTraining
                      ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                      : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
                }`}
              >
                {isTraining ? (
                  <>
                    <Square className="w-4 h-4" />
                    停止训练
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    开始{config.mode === 'finetune' ? '微调' : '预训练'}
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Training Progress */}
        {(isTraining || trainingLogs.length > 0) && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-zinc-400" />
                <span className="text-sm font-medium text-zinc-200">训练进度</span>
              </div>
              {isTraining && (
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-zinc-500">
                    Step: <span className="text-zinc-400">{currentStep}</span> / {config.maxIters}
                  </span>
                  {currentLoss !== null && (
                    <span className="text-zinc-500">
                      Loss: <span className="text-emerald-400">{currentLoss.toFixed(4)}</span>
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Progress Bar */}
            {isTraining && (
              <div className="w-full h-2 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500/50 transition-all duration-300"
                  style={{ width: `${(currentStep / config.maxIters) * 100}%` }}
                />
              </div>
            )}

            {/* Logs */}
            <div className="bg-zinc-950/50 rounded-lg border border-zinc-700 p-4 h-48 overflow-y-auto font-mono text-xs">
              {trainingLogs.map((log, idx) => (
                <div key={idx} className="text-zinc-400 py-0.5">
                  {log}
                </div>
              ))}
              {isTraining && (
                <div className="text-zinc-500 animate-pulse">▌</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
