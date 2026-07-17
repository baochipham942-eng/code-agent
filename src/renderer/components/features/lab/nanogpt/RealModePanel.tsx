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
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import type {
  PythonEnvStatus,
  LabProjectStatus,
  TrainingProgressEvent,
} from '../../../../../shared/contract/lab';

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
  const { t } = useI18n();
  const nano = t.labNanogpt.realMode;
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
    const result = await ipcService.invoke(IPC_CHANNELS.LAB_CHECK_PYTHON_ENV);
    setPythonEnv(result ?? null);
  }, []);

  // 获取项目状态
  const getProjectStatus = useCallback(async () => {
    const result = await ipcService.invoke(IPC_CHANNELS.LAB_GET_PROJECT_STATUS, 'nanogpt');
    setProjectStatus(result ?? null);
  }, []);

  // 下载项目
  const downloadProject = useCallback(async () => {
    setIsDownloading(true);
    setTrainingLogs((prev) => [...prev, nano.logDownloadStart]);

    const result = await ipcService.invoke(IPC_CHANNELS.LAB_DOWNLOAD_PROJECT, {
      projectType: 'nanogpt',
    });

    if (result?.success) {
      setTrainingLogs((prev) => [...prev, nano.logDownloadComplete]);
      await getProjectStatus();
    } else {
      setTrainingLogs((prev) => [
        ...prev,
        nano.logDownloadFailed.replace('{error}', result?.error || nano.unknownError),
      ]);
    }

    setIsDownloading(false);
  }, [getProjectStatus, nano]);

  // 开始训练
  const startTraining = useCallback(async () => {
    setIsTraining(true);
    setTrainingLogs((prev) => [
      ...prev,
      config.mode === 'finetune' ? nano.logTrainStartFinetune : nano.logTrainStartPretrain,
    ]);
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

    const result = await ipcService.invoke(IPC_CHANNELS.LAB_START_TRAINING, {
      projectType: 'nanogpt',
      config: trainingConfig,
    });

    if (!result?.success) {
      setTrainingLogs((prev) => [
        ...prev,
        nano.logTrainStartFailed.replace('{error}', result?.error || nano.unknownError),
      ]);
      setIsTraining(false);
    }
  }, [config, nano]);

  // 停止训练
  const stopTraining = useCallback(async () => {
    setTrainingLogs((prev) => [...prev, nano.logStopping]);
    await ipcService.invoke(IPC_CHANNELS.LAB_STOP_TRAINING, 'nanogpt');
    setIsTraining(false);
    setTrainingLogs((prev) => [...prev, nano.logStopped]);
  }, [nano]);

  // 监听训练进度事件
  useEffect(() => {
    const unsubscribe = ipcService.on(
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
          setTrainingLogs((prev) => [...prev, nano.logComplete]);
        } else if (event.type === 'error') {
          setIsTraining(false);
          setTrainingLogs((prev) => [...prev, nano.logErrorPrefix.replace('{message}', event.message ?? '')]);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [nano]);

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
            <h2 className="text-lg font-semibold text-zinc-200">{nano.title}</h2>
            <p className="text-sm text-zinc-500">{nano.subtitle}</p>
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
              <span className="text-sm font-medium text-zinc-200">{nano.pythonEnvLabel}</span>
            </div>
            {pythonEnv ? (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">{nano.pythonLabel}</span>
                  <span className={pythonEnv.pythonInstalled ? 'text-emerald-400' : 'text-red-400'}>
                    {pythonEnv.pythonInstalled ? pythonEnv.pythonVersion : nano.notInstalled}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">{nano.pytorchLabel}</span>
                  <span className={pythonEnv.pytorchInstalled ? 'text-emerald-400' : 'text-red-400'}>
                    {pythonEnv.pytorchInstalled ? pythonEnv.pytorchVersion : nano.notInstalled}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">{nano.tiktokenLabel}</span>
                  <span className={pythonEnv.sentencepieceInstalled ? 'text-emerald-400' : 'text-amber-400'}>
                    {pythonEnv.sentencepieceInstalled ? nano.installed : nano.needInstall}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                {nano.detecting}
              </div>
            )}
          </div>

          {/* Project Status */}
          <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <FolderOpen className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">{nano.projectStatusLabel}</span>
            </div>
            {projectStatus ? (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">{nano.downloadedLabel}</span>
                  {projectStatus.downloaded ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-zinc-500" />
                  )}
                </div>
                {projectStatus.downloaded && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500">{nano.pathLabel}</span>
                      <span className="text-zinc-400 truncate max-w-[200px]" title={projectStatus.projectPath || ''}>
                        {projectStatus.projectPath?.split('/').slice(-2).join('/')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500">{nano.trainedModelLabel}</span>
                      {projectStatus.hasTrainedModel ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <span className="text-zinc-500">{nano.noneLabel}</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                {nano.detecting}
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
                {nano.downloading}
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                {nano.downloadProject}
              </>
            )}
          </button>
        )}

        {/* Training Configuration */}
        {projectStatus?.downloaded && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">{nano.trainingConfigLabel}</span>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Training Mode */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">{nano.trainingModeLabel}</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfig((c) => ({ ...c, mode: 'finetune', initFrom: 'gpt2' }))}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs transition-all ${
                      config.mode === 'finetune'
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
                    }`}
                  >
                    {nano.finetuneOption}
                  </button>
                  <button
                    onClick={() => setConfig((c) => ({ ...c, mode: 'pretrain', initFrom: 'scratch' }))}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs transition-all ${
                      config.mode === 'pretrain'
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        : 'bg-zinc-800 text-zinc-500 border border-zinc-800'
                    }`}
                  >
                    {nano.pretrainOption}
                  </button>
                </div>
              </div>

              {/* Init From */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">{nano.initFromLabel}</label>
                <select
                  value={config.initFrom}
                  onChange={(e) => setConfig((c) => ({ ...c, initFrom: e.target.value as InitFrom }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                >
                  <option value="scratch">{nano.fromScratchOption}</option>
                  <option value="gpt2">{nano.gpt2Option}</option>
                  <option value="gpt2-medium">{nano.gpt2MediumOption}</option>
                </select>
              </div>

              {/* Device */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">{nano.deviceLabel}</label>
                <select
                  value={config.device}
                  onChange={(e) => setConfig((c) => ({ ...c, device: e.target.value as 'cpu' | 'mps' | 'cuda' }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                >
                  <option value="cpu">{nano.cpuOption}</option>
                  <option value="mps">{nano.mpsOption}</option>
                  <option value="cuda">{nano.cudaOption}</option>
                </select>
              </div>

              {/* Batch Size */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">{nano.batchSizeLabel}</label>
                <input
                  type="number"
                  value={config.batchSize}
                  onChange={(e) => setConfig((c) => ({ ...c, batchSize: parseInt(e.target.value) || 12 }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                />
              </div>

              {/* Learning Rate */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">{nano.learningRateLabel}</label>
                <input
                  type="text"
                  value={config.learningRate.toExponential(0)}
                  onChange={(e) => setConfig((c) => ({ ...c, learningRate: parseFloat(e.target.value) || 3e-5 }))}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400"
                />
              </div>

              {/* Max Iters */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-500">{nano.maxItersLabel}</label>
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
                    {nano.stopTraining}
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    {config.mode === 'finetune' ? nano.startFinetune : nano.startPretrain}
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
                <span className="text-sm font-medium text-zinc-200">{nano.progressLabel}</span>
              </div>
              {isTraining && (
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-zinc-500">
                    {nano.stepLabel}: <span className="text-zinc-400">{currentStep}</span> / {config.maxIters}
                  </span>
                  {currentLoss !== null && (
                    <span className="text-zinc-500">
                      {nano.lossLabel}: <span className="text-emerald-400">{currentLoss.toFixed(4)}</span>
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
