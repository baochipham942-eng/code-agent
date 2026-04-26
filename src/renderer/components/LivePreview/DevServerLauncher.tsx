// ============================================================================
// DevServerLauncher - V2-A
// ----------------------------------------------------------------------------
// 模态：选项目目录 → 探测框架 → 启动 dev server → 等 ready → openLivePreview
//
// 状态机：
//   idle       初始 / 用户选错回到这里
//   detecting  IPC detectFramework 飞行中
//   detected   有 detection 结果（可能 supported=false）
//   starting   IPC startDevServer 已发，等 waitDevServerReady
//   ready      已拿到 URL（一闪而过 → 关闭模态 + openLivePreview）
//   failed     启动失败 / 探测失败
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, Play, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { invokeDomain } from '../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { isTauriMode, isWebMode } from '../../utils/platform';
import type {
  DevServerLogEntry,
  DevServerSession,
  FrameworkDetectionResult,
} from '@shared/livePreview/devServer';

type LauncherStatus = 'idle' | 'detecting' | 'detected' | 'starting' | 'ready' | 'failed';

interface LauncherState {
  status: LauncherStatus;
  projectPath: string;
  detection: FrameworkDetectionResult | null;
  session: DevServerSession | null;
  logs: DevServerLogEntry[];
  error: string | null;
}

const INITIAL: LauncherState = {
  status: 'idle',
  projectPath: '',
  detection: null,
  session: null,
  logs: [],
  error: null,
};

async function pickDirectory(initial: string): Promise<string | null> {
  if (isTauriMode()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title: '选择项目目录' });
    return typeof result === 'string' ? result : null;
  }
  if (isWebMode()) {
    return window.prompt('输入项目目录绝对路径', initial)?.trim() || null;
  }
  return null;
}

export const DevServerLauncher: React.FC = () => {
  const open = useAppStore((s) => s.devServerLauncherOpen);
  const closeModal = useAppStore((s) => s.closeDevServerLauncher);
  const openLivePreview = useAppStore((s) => s.openLivePreview);

  const [state, setState] = useState<LauncherState>(INITIAL);
  const logTailRef = useRef<HTMLDivElement>(null);

  // 模态打开时重置；关掉时不重置（避免 close 动画期间布局抖动）
  useEffect(() => {
    if (open) setState(INITIAL);
  }, [open]);

  // logs 自动滚到底
  useEffect(() => {
    logTailRef.current?.scrollTo({ top: logTailRef.current.scrollHeight });
  }, [state.logs]);

  const handlePickDir = useCallback(async () => {
    try {
      const picked = await pickDirectory(state.projectPath);
      if (!picked) return;
      setState((s) => ({ ...s, status: 'detecting', projectPath: picked, error: null }));
      const detection = await invokeDomain<FrameworkDetectionResult>(
        IPC_DOMAINS.LIVE_PREVIEW,
        'detectFramework',
        { path: picked },
      );
      setState((s) => ({ ...s, status: 'detected', detection }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [state.projectPath]);

  const handleStart = useCallback(async () => {
    if (!state.detection?.supported) return;
    setState((s) => ({ ...s, status: 'starting', error: null, logs: [] }));

    let session: DevServerSession;
    try {
      session = await invokeDomain<DevServerSession>(
        IPC_DOMAINS.LIVE_PREVIEW,
        'startDevServer',
        { path: state.projectPath },
      );
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }));
      return;
    }

    setState((s) => ({ ...s, session }));

    // 边等 ready 边轮询 logs（每 500ms），让用户看到 vite 启动过程
    const logsTimer = setInterval(async () => {
      try {
        const logs = await invokeDomain<DevServerLogEntry[]>(
          IPC_DOMAINS.LIVE_PREVIEW,
          'getDevServerLogs',
          { sessionId: session.sessionId },
        );
        setState((s) => (s.session?.sessionId === session.sessionId ? { ...s, logs } : s));
      } catch {
        /* 不影响 ready 等待 */
      }
    }, 500);

    try {
      const { url } = await invokeDomain<{ url: string }>(
        IPC_DOMAINS.LIVE_PREVIEW,
        'waitDevServerReady',
        { sessionId: session.sessionId },
      );
      clearInterval(logsTimer);
      setState((s) => ({ ...s, status: 'ready' }));
      // 关掉模态 + 开 live preview tab
      openLivePreview(url, session.sessionId);
      setTimeout(closeModal, 200); // 让 ready 状态闪一下，UX 反馈
    } catch (err) {
      clearInterval(logsTimer);
      // 拿一次最终 logs 给用户看
      try {
        const logs = await invokeDomain<DevServerLogEntry[]>(
          IPC_DOMAINS.LIVE_PREVIEW,
          'getDevServerLogs',
          { sessionId: session.sessionId },
        );
        setState((s) => ({
          ...s,
          status: 'failed',
          logs,
          error: err instanceof Error ? err.message : String(err),
        }));
      } catch {
        setState((s) => ({
          ...s,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }, [state.detection, state.projectPath, openLivePreview, closeModal]);

  const handleCancel = useCallback(async () => {
    if (state.session && (state.status === 'starting' || state.status === 'failed')) {
      try {
        await invokeDomain(IPC_DOMAINS.LIVE_PREVIEW, 'stopDevServer', {
          sessionId: state.session.sessionId,
        });
      } catch {
        /* swallow */
      }
    }
    closeModal();
  }, [state.session, state.status, closeModal]);

  if (!open) return null;

  const detection = state.detection;
  const supported = detection?.supported ?? false;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleCancel}
      data-testid="dev-server-launcher-backdrop"
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <Play className="h-4 w-4 text-emerald-400" />
            启动 Dev Server
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-4">
          {/* 1. 选目录 */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
              项目目录
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={state.projectPath}
                placeholder="点右侧按钮选择…"
                className="flex-1 min-w-0 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600"
              />
              <button
                type="button"
                onClick={handlePickDir}
                disabled={state.status === 'detecting' || state.status === 'starting'}
                className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50"
                data-testid="dev-server-launcher-pick"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                选目录
              </button>
            </div>
          </div>

          {/* 2. 探测结果 */}
          {state.status === 'detecting' && (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              探测框架中…
            </div>
          )}
          {detection && state.status !== 'detecting' && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                supported
                  ? 'border-emerald-900/40 bg-emerald-950/20 text-emerald-200'
                  : 'border-amber-900/40 bg-amber-950/20 text-amber-200'
              }`}
              data-testid="dev-server-launcher-detection"
            >
              <div className="flex items-center gap-2">
                {supported ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="font-medium">{detection.framework}</span>
                <span className="text-zinc-400">·</span>
                <span className="text-zinc-400">{detection.packageManager}</span>
                {detection.devScript && (
                  <>
                    <span className="text-zinc-400">·</span>
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                      {detection.devScript}
                    </code>
                  </>
                )}
              </div>
              {detection.reason && (
                <div className="mt-1.5 text-[11px] leading-relaxed text-zinc-300">{detection.reason}</div>
              )}
            </div>
          )}

          {/* 3. 启动状态 + 日志 */}
          {(state.status === 'starting' || state.status === 'failed' || state.logs.length > 0) && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
                <span>{state.status === 'starting' ? '启动中…' : '日志'}</span>
                {state.session && (
                  <code className="text-[10px] text-zinc-600">
                    {state.session.sessionId.slice(0, 8)}
                  </code>
                )}
              </div>
              <div
                ref={logTailRef}
                className="max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-400"
                data-testid="dev-server-launcher-logs"
              >
                {state.logs.length === 0 ? (
                  <span className="text-zinc-600">{state.status === 'starting' ? '等待 stdout…' : '暂无日志'}</span>
                ) : (
                  state.logs.slice(-50).map((log, i) => (
                    <div
                      key={`${log.ts}-${i}`}
                      className={log.stream === 'stderr' ? 'text-rose-300' : ''}
                    >
                      {log.line}
                    </div>
                  ))
                )}
              </div>
              {state.error && (
                <div className="mt-1.5 text-[11px] text-rose-300" data-testid="dev-server-launcher-error">
                  {state.error}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={!supported || state.status === 'starting' || state.status === 'ready'}
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="dev-server-launcher-start"
          >
            {state.status === 'starting' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {state.status === 'ready' ? '已就绪' : '启动'}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default DevServerLauncher;
