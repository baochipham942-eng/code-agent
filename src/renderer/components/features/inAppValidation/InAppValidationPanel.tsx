import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RotateCw, AlertTriangle, CheckCircle2, Code2, Radio } from 'lucide-react';
import { runInAppInteractions } from '../../../utils/inAppValidationExecutor';
import { ipcService } from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '../../../stores/appStore';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import type {
  BrowserInteractionStep,
  BrowserInteractionStepResult,
} from '../../../../shared/contract/browserInteraction';

const DEMO_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>in-app demo</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; background: #0f172a; color: #e2e8f0; }
  button { padding: 8px 16px; font-size: 14px; cursor: pointer; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; }
  button:hover { background: #334155; }
  #msg { margin-top: 16px; padding: 12px; border-radius: 6px; background: #14532d; color: #bbf7d0; display: none; }
  input { padding: 8px; border-radius: 4px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; margin-right: 8px; }
  .row { margin-top: 16px; }
</style>
</head>
<body>
  <h2 style="margin-top:0">In-App Validation Demo</h2>
  <div class="row">
    <button id="toggle">Toggle</button>
    <div id="msg">已切换为可见</div>
  </div>
  <div class="row">
    <input id="name" placeholder="输入姓名" />
    <button id="greet">问好</button>
    <div id="greeting" style="margin-top:8px;"></div>
  </div>
  <script>
    document.getElementById('toggle').addEventListener('click', () => {
      const msg = document.getElementById('msg');
      msg.style.display = msg.style.display === 'block' ? 'none' : 'block';
    });
    document.getElementById('greet').addEventListener('click', () => {
      const name = document.getElementById('name').value;
      document.getElementById('greeting').textContent = name ? '你好, ' + name + '!' : '请先输入姓名';
    });
  </script>
</body></html>
`;

const DEMO_STEPS: BrowserInteractionStep[] = [
  {
    label: '点切换按钮',
    action: { type: 'click-selector', selector: '#toggle' },
    expect: { textVisible: '已切换为可见', timeoutMs: 1500 },
  },
  {
    label: '再点切换按钮（隐藏）',
    action: { type: 'click-selector', selector: '#toggle' },
    expect: { textHidden: '已切换为可见', timeoutMs: 1500 },
  },
  {
    label: '点输入框',
    action: { type: 'click-selector', selector: '#name' },
  },
  {
    label: '输入姓名',
    action: { type: 'type', text: '林晨' },
  },
  {
    label: '点问好按钮',
    action: { type: 'click-selector', selector: '#greet' },
    expect: { textVisible: '你好, 林晨!', timeoutMs: 1500 },
  },
];

export function InAppValidationPanel(): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [htmlSource, setHtmlSource] = useState<string>(DEMO_HTML);
  const [stepsText, setStepsText] = useState<string>(() => JSON.stringify(DEMO_STEPS, null, 2));
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BrowserInteractionStepResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [manualReloadKey, setManualReloadKey] = useState(0);
  const activeIpcRequestRef = useRef<{ requestId: string } | null>(null);

  const pendingRequest = useAppStore((s) => s.pendingInAppValidationRequest);
  const setPendingRequest = useAppStore((s) => s.setPendingInAppValidationRequest);
  const setShowInAppValidationPanel = useAppStore((s) => s.setShowInAppValidationPanel);

  const reloadIframe = useCallback(() => {
    setIframeReady(false);
    setManualReloadKey((k) => k + 1);
  }, []);

  const runScript = useCallback(async () => {
    if (!iframeRef.current) return;
    if (!iframeReady) {
      setError('iframe 还没加载完，再等等。');
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const parsed = JSON.parse(stepsText) as BrowserInteractionStep[];
      const result = await runInAppInteractions(iframeRef.current, parsed);
      setResults(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      setRunning(false);
    }
  }, [stepsText, iframeReady]);

  const loadDemo = useCallback(() => {
    setHtmlSource(DEMO_HTML);
    setStepsText(JSON.stringify(DEMO_STEPS, null, 2));
    setResults([]);
    setError(null);
    if (iframeRef.current) {
      setIframeReady(false);
      iframeRef.current.srcdoc = DEMO_HTML;
    }
  }, []);

  // IPC 入口：main 端发来 request → 注入 HTML+steps；iframe 通过 key={requestId} 强制
  // 重 mount，加载完后 onLoad 把 iframeReady 翻 true，下一个 effect 自动跑并回传。
  useEffect(() => {
    if (!pendingRequest) return;
    activeIpcRequestRef.current = { requestId: pendingRequest.requestId };
    setHtmlSource(pendingRequest.html);
    setStepsText(JSON.stringify(pendingRequest.steps, null, 2));
    setResults([]);
    setError(null);
    setIframeReady(false);
  }, [pendingRequest]);

  useEffect(() => {
    const activeRequest = activeIpcRequestRef.current;
    if (!activeRequest || !iframeReady || !pendingRequest) return;
    if (activeRequest.requestId !== pendingRequest.requestId) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let cancelled = false;
    setRunning(true);
    runInAppInteractions(iframe, pendingRequest.steps)
      .then(async (stepResults) => {
        if (cancelled) return;
        setResults(stepResults);
        await ipcService.invoke(IPC_CHANNELS.IN_APP_VALIDATION_RESULT, {
          requestId: activeRequest.requestId,
          results: stepResults,
        });
      })
      .catch(async (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        await ipcService.invoke(IPC_CHANNELS.IN_APP_VALIDATION_RESULT, {
          requestId: activeRequest.requestId,
          error: message,
        });
      })
      .finally(() => {
        if (cancelled) return;
        setRunning(false);
        activeIpcRequestRef.current = null;
        setPendingRequest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [iframeReady, pendingRequest, setPendingRequest]);

  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const allPassed = totalCount > 0 && passedCount === totalCount;
  const ipcActive = Boolean(pendingRequest);

  return (
    <FullScreenPage testId="in-app-validation-panel">
      <FullScreenPageHeader
        icon={<Code2 className="h-4 w-4 text-emerald-300" />}
        title="In-App 验证"
        description="在应用内沙箱验证 HTML 预览和交互脚本"
        badge={ipcActive ? (
          <span className="flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200">
            <Radio className="h-3 w-3 animate-pulse" /> IPC 驱动中
          </span>
        ) : totalCount > 0 ? (
          <span
            className={`rounded border px-2 py-0.5 text-xs ${
              allPassed
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
            }`}
          >
            {passedCount}/{totalCount} passed
          </span>
        ) : null}
        onClose={() => setShowInAppValidationPanel(false)}
        closeLabel="关闭 In-App 验证"
        actions={(
          <>
          <button
            type="button"
            onClick={loadDemo}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            载入 Demo
          </button>
          <button
            type="button"
            onClick={reloadIframe}
            className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <RotateCw className="h-3 w-3" /> 重载
          </button>
          <button
            type="button"
            onClick={runScript}
            disabled={running}
            className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            <Play className="h-3 w-3" /> {running ? '运行中...' : '运行脚本'}
          </button>
          </>
        )}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 flex-col border-r border-slate-800">
          <div className="border-b border-slate-800 px-3 py-1 text-xs text-slate-400">iframe 预览（沙箱）</div>
          <iframe
            key={pendingRequest?.requestId || `manual-${manualReloadKey}`}
            ref={iframeRef}
            title="in-app-validation-preview"
            srcDoc={htmlSource}
            onLoad={() => setIframeReady(true)}
            className="flex-1 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>

        <div className="flex w-[480px] flex-col">
          <div className="flex flex-col border-b border-slate-800">
            <div className="px-3 py-1 text-xs text-slate-400">HTML 源码</div>
            <textarea
              className="h-36 resize-none bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 outline-hidden"
              value={htmlSource}
              onChange={(e) => setHtmlSource(e.target.value)}
            />
          </div>
          <div className="flex flex-1 flex-col">
            <div className="px-3 py-1 text-xs text-slate-400">Step 脚本（JSON）</div>
            <textarea
              className="flex-1 resize-none bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 outline-hidden"
              value={stepsText}
              onChange={(e) => setStepsText(e.target.value)}
            />
          </div>
          <div className="max-h-80 overflow-auto border-t border-slate-800 bg-slate-950 px-3 py-2 text-xs">
            {error && (
              <div className="mb-2 flex items-start gap-1 rounded bg-rose-900/40 p-2 text-rose-200">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {results.length === 0 && !error && (
              <div className="text-slate-500">点"运行脚本"开始验证</div>
            )}
            {results.map((result, index) => (
              <div
                key={index}
                className={`mb-2 rounded border p-2 ${
                  result.passed
                    ? 'border-emerald-800 bg-emerald-950/40'
                    : 'border-rose-800 bg-rose-950/40'
                }`}
              >
                <div className="flex items-center gap-1">
                  {result.passed ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 text-rose-400" />
                  )}
                  <span className="font-medium">
                    {result.label || result.action.type}
                  </span>
                  <span className="ml-auto text-slate-500">{result.durationMs}ms</span>
                </div>
                {result.checks.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-emerald-300">
                    {result.checks.map((check, i) => (
                      <li key={i}>{check}</li>
                    ))}
                  </ul>
                )}
                {result.failures.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-rose-300">
                    {result.failures.map((failure, i) => (
                      <li key={i}>{failure}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </FullScreenPage>
  );
}
