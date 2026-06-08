// ============================================================================
// PrivacySettings — 隐私防线设置 tab (B3 一键启用本地 PII 防线)
//
// 后端 IPC: domain:pii (src/main/ipc/pii.ipc.ts)
//   actions: setup:start / setup:cancel / setup:status / setup:isReady
//   push  : IPC_CHANNELS.PII_SETUP_EVENT (log/step/state)
//
// 流程:
//   1. mount -> 同时拉 status + isReady
//   2. subscribe PII_SETUP_EVENT 把 log/step/state 转入 React state
//   3. 用户点击「启用」-> invoke setup:start -> 后端 spawn 脚本流式输出
//   4. 完成后再调一次 isReady,显示「已生效」绿勾
// ============================================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldCheck, Loader2, AlertTriangle, RefreshCw, XCircle, Activity } from 'lucide-react';
import { IPC_DOMAINS, IPC_CHANNELS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import ipcService from '../../../../services/ipcService';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage, SettingsSection } from '../SettingsLayout';

type SetupState = 'idle' | 'running' | 'completed' | 'error';

interface SetupStatus {
  state: SetupState;
  startedAt: number | null;
  error: string | null;
  logTail: Array<{ stream: 'stdout' | 'stderr'; line: string; ts: number }>;
}

interface ReadyStatus {
  ready: boolean;
  envFile: { exists: boolean; hasPiiKeys: boolean };
  pythonPath: string | null;
  modelOnnx: string | null;
}

type SetupEvent =
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'step'; description: string }
  | { type: 'state'; state: SetupState; error?: string };

const STATE_LABEL: Record<SetupState, { dot: string; text: string }> = {
  idle:      { dot: 'bg-zinc-500',  text: '未启用' },
  running:   { dot: 'bg-yellow-500 animate-pulse', text: '安装中…' },
  completed: { dot: 'bg-green-500', text: '已完成' },
  error:     { dot: 'bg-red-500',   text: '失败' },
};

function getSetupLogLineClass(entry: { stream: 'stdout' | 'stderr'; line: string }): string {
  const line = entry.line.trim();
  if (line.startsWith('❌')) return 'text-red-400';
  if (line.startsWith('▷ STEP:')) return 'text-cyan-300';
  if (line.startsWith('✓')) return 'text-green-400';
  if (entry.stream === 'stderr' && /\b(error|failed|failure|fatal|exception|traceback)\b/i.test(line)) {
    return 'text-red-400';
  }
  return entry.stream === 'stderr' ? 'text-zinc-400' : 'text-zinc-300';
}

const PrivacySettings: React.FC = () => {
  const [state, setState] = useState<SetupState>('idle');
  const [step, setStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ stream: 'stdout' | 'stderr'; line: string }>>([]);
  const [ready, setReady] = useState<ReadyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // 遥测（Langfuse）opt-out 开关。默认开启;enabled === false 才算关闭。
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const langfuseCfgRef = useRef<NonNullable<AppSettings['langfuse']> | undefined>(undefined);

  const refreshReady = useCallback(async () => {
    try {
      const r = await ipcService.invokeDomain<ReadyStatus>(IPC_DOMAINS.PII, 'setup:isReady');
      if (r) setReady(r);
    } catch {
      // ignore
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await ipcService.invokeDomain<SetupStatus>(IPC_DOMAINS.PII, 'setup:status');
      if (s) {
        setState(s.state);
        setError(s.error);
        setLogs(s.logTail.map((l) => ({ stream: l.stream, line: l.line })));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (isWebMode()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      await Promise.all([refreshStatus(), refreshReady()]);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [refreshStatus, refreshReady]);

  // 加载遥测开关状态（desktop only）
  useEffect(() => {
    if (isWebMode()) return;
    (async () => {
      try {
        const s = await ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get');
        langfuseCfgRef.current = s?.langfuse;
        setTelemetryEnabled(s?.langfuse?.enabled !== false);
      } catch {
        // ignore — 默认视为开启
      }
    })();
  }, []);

  const handleTelemetryToggle = useCallback(async (next: boolean) => {
    setTelemetrySaving(true);
    setTelemetryEnabled(next); // 乐观更新
    try {
      // 浅合并:先 spread 现有 langfuse 配置,避免把 publicKey/secretKey 抹掉
      const nextCfg = { ...(langfuseCfgRef.current ?? {}), enabled: next } as NonNullable<AppSettings['langfuse']>;
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { langfuse: nextCfg } as Partial<AppSettings>);
      langfuseCfgRef.current = nextCfg;
    } catch {
      setTelemetryEnabled(!next); // 回滚
    } finally {
      setTelemetrySaving(false);
    }
  }, []);

  // 订阅流式 push 事件
  useEffect(() => {
    if (isWebMode()) return undefined;
    const unsub = ipcService.on?.(IPC_CHANNELS.PII_SETUP_EVENT, ((evt: SetupEvent) => {
      if (evt.type === 'log') {
        setLogs((prev) => {
          const next = [...prev, { stream: evt.stream, line: evt.line }];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } else if (evt.type === 'step') {
        setStep(evt.description);
      } else if (evt.type === 'state') {
        setState(evt.state);
        setError(evt.error || null);
        if (evt.state === 'completed') {
          void refreshReady();
        }
      }
    }) as never);
    return () => { unsub?.(); };
  }, [refreshReady]);

  // 自动滚到底部
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [logs.length]);

  const handleStart = useCallback(async () => {
    setLogs([]);
    setStep('');
    setError(null);
    try {
      const result = await ipcService.invokeDomain<{ started: boolean; error?: string }>(
        IPC_DOMAINS.PII,
        'setup:start',
      );
      if (result && !result.started && result.error) {
        setError(result.error);
        setState('error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }, []);

  const handleCancel = useCallback(async () => {
    await ipcService.invokeDomain<{ cancelled: boolean }>(IPC_DOMAINS.PII, 'setup:cancel');
  }, []);

  if (isWebMode()) {
    return (
      <SettingsPage
        title="隐私防线"
        description="本地 PII 防线，启用后协作内容进入云端 LLM 前自动脱敏命名实体（姓名/地址/医疗 ID 等）。"
      >
        <WebModeBanner />
      </SettingsPage>
    );
  }

  const isReadyGreen = ready?.ready === true;
  const stateLabel = STATE_LABEL[state];

  return (
    <SettingsPage
      title="隐私防线"
      description="本地 PII 防线（GLiNER ONNX）。启用后，协作内容进入云端 LLM 前自动识别并脱敏命名实体（姓名/地址/医疗 ID/银行账号等）。模型在本地运行，首次会下载约 190MB 的量化模型到 ~/.cache/code-agent/gliner-pii/。"
    >
      <SettingsSection
        title="使用数据上报（Telemetry）"
        description="默认开启。上报运行轨迹（模型/工具调用、token、错误分类、版本指纹等）用于诊断与产品改进。关闭后本次设备不再向云端上报，改动重启后生效。"
      >
        <label className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary-600"
            checked={telemetryEnabled}
            disabled={telemetrySaving}
            onChange={(e) => handleTelemetryToggle(e.target.checked)}
          />
          <div className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-zinc-400" />
            <div>
              <div className="text-zinc-200 font-medium">
                {telemetryEnabled ? '已开启遥测上报' : '已关闭遥测上报'}
              </div>
              <div className="text-xs text-zinc-400 mt-0.5">
                取消勾选即可 opt-out。当前版本默认上报运行轨迹的元数据，不含完整 prompt/代码内容。
              </div>
            </div>
          </div>
        </label>
      </SettingsSection>

      <SettingsSection
        title="状态"
        description="是否已配置完成 + 当前任务状态"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            {isReadyGreen ? (
              <>
                <ShieldCheck className="h-5 w-5 text-green-400" />
                <div className="text-sm">
                  <div className="text-zinc-200 font-medium">本地 PII 防线已生效</div>
                  <div className="text-xs text-zinc-400 mt-0.5">
                    模型: {ready?.modelOnnx} · Python: {ready?.pythonPath}
                  </div>
                </div>
              </>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-zinc-500" />
                <div className="text-sm text-zinc-300">
                  {ready?.envFile.exists
                    ? '配置存在但未生效（venv 或模型文件缺失）'
                    : '尚未启用本地 PII 防线'}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${stateLabel.dot}`} />
            <span className="text-zinc-300">{stateLabel.text}</span>
            {step && (
              <span className="text-xs text-zinc-500">· {step}</span>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-900/40 bg-red-950/30 p-3 text-sm text-red-300">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1 whitespace-pre-wrap break-words">{error}</div>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="操作"
        description="一键启用流程：准备 Python 3.12 运行环境 → 安装本地识别依赖 → 下载约 190MB 量化模型 → 写 ~/.code-agent/.env"
      >
        <div className="flex flex-wrap gap-3">
          {state === 'running' ? (
            <button
              type="button"
              onClick={handleCancel}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" />
              取消
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === 'completed' || isReadyGreen ? (
                <>
                  <RefreshCw className="h-4 w-4" />
                  重新装
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  启用本地 PII 防线
                </>
              )}
            </button>
          )}
          {state === 'running' && (
            <span className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              首次需要下载运行环境和模型,可在后台等待
            </span>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="日志"
        description="脚本实时输出（自动滚动）"
      >
        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-zinc-600">暂无输出</div>
          ) : (
            logs.map((entry, idx) => (
              <div
                key={idx}
                className={getSetupLogLineClass(entry)}
              >
                {entry.line}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </SettingsSection>
    </SettingsPage>
  );
};

export default PrivacySettings;
