// ============================================================================
// InAppValidationWorkspace - 应用内验证工作台（可嵌入）
//
// 契约：
// - 不含 FullScreenPage 外壳；作为评测中心「验证」tab 的内容挂载，页面框架由外层负责。
// - IPC 入口：main 端 IN_APP_VALIDATION_REQUEST → appStore.pendingInAppValidationRequest。
//   本组件消费 pending 请求：注入 HTML+steps、iframe 以 requestId 强制重 mount、
//   加载完自动跑并经 IN_APP_VALIDATION_RESULT 回传。
// - 脏保护：用户手动改过 HTML/steps（dirty）后，新 IPC 请求不得静默覆盖——挂起为
//   heldRequest，顶部横幅让用户选「加载新请求」（覆盖并照常执行）或「保留当前编辑」
//   （回传 error 拒绝，main 端 promise 立即 reject，而不是干等 30s 超时）。
// - 2026-07-27 粗糙点收尾：
//   ① steps 编辑器抽成 StepsJsonEditor（行号 gutter + 失焦 JSON 校验即时报错）；
//   ② HTML 源 textarea 默认 12 行且可拖拽加高（rows=12 + resize-y）；
//   ③ 结果区加失败汇总头（sticky 置顶：通过徽标 + N 失败），失败卡片排在通过之前；
//   ④ 术语全走 i18n（通过徽标 / 区块标题 / iframe 未就绪提示）；
//   ⑤ 运行中「重载」按钮 disabled；结果卡片 key 用每次运行生成的稳定 id（不用 index）。
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RotateCw, AlertTriangle, CheckCircle2, Radio } from 'lucide-react';
import { runInAppInteractions } from '../../../utils/inAppValidationExecutor';
import { ipcService } from '../../../services/ipcService';
import { IPC_CHANNELS } from '@shared/ipc';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { StepsJsonEditor } from './StepsJsonEditor';
import type {
  BrowserInteractionStep,
  BrowserInteractionStepResult,
  InAppValidationRequest,
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
    action: { type: 'type', text: '测试用户' },
  },
  {
    label: '点问好按钮',
    action: { type: 'click-selector', selector: '#greet' },
    expect: { textVisible: '你好, 测试用户!', timeoutMs: 1500 },
  },
];

export function InAppValidationWorkspace(): React.ReactElement {
  const { t } = useI18n();
  const v = t.evalCenter.validation;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [htmlSource, setHtmlSource] = useState<string>(DEMO_HTML);
  const [stepsText, setStepsText] = useState<string>(() => JSON.stringify(DEMO_STEPS, null, 2));
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BrowserInteractionStepResult[]>([]);
  // 结果卡片稳定 key：每次写入结果时生成一轮新 id，重渲染不复用 index。
  const resultKeySeqRef = useRef(0);
  const resultKeysRef = useRef<string[]>([]);
  const setResultsWithKeys = useCallback((next: BrowserInteractionStepResult[]) => {
    resultKeysRef.current = next.map(() => `result-${++resultKeySeqRef.current}`);
    setResults(next);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [manualReloadKey, setManualReloadKey] = useState(0);
  // 脏保护：用户手动编辑过 HTML/steps 即 dirty；IPC 加载 / Demo 加载后复位。
  const [dirty, setDirty] = useState(false);
  const [heldRequest, setHeldRequest] = useState<InAppValidationRequest | null>(null);
  const activeIpcRequestRef = useRef<{ requestId: string } | null>(null);

  const pendingRequest = useAppStore((s) => s.pendingInAppValidationRequest);
  const setPendingRequest = useAppStore((s) => s.setPendingInAppValidationRequest);

  const reloadIframe = useCallback(() => {
    setIframeReady(false);
    setManualReloadKey((k) => k + 1);
  }, []);

  const runScript = useCallback(async () => {
    if (!iframeRef.current) return;
    if (!iframeReady) {
      setError(v.iframeNotReady);
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const parsed = JSON.parse(stepsText) as BrowserInteractionStep[];
      const result = await runInAppInteractions(iframeRef.current, parsed);
      setResultsWithKeys(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResultsWithKeys([]);
    } finally {
      setRunning(false);
    }
  }, [stepsText, iframeReady, setResultsWithKeys, v.iframeNotReady]);

  const loadDemo = useCallback(() => {
    setHtmlSource(DEMO_HTML);
    setStepsText(JSON.stringify(DEMO_STEPS, null, 2));
    setResultsWithKeys([]);
    setError(null);
    setDirty(false);
    if (iframeRef.current) {
      setIframeReady(false);
      iframeRef.current.srcdoc = DEMO_HTML;
    }
  }, [setResultsWithKeys]);

  // 应用一条 IPC 请求：注入内容并标记 active，iframe 重 mount 后由下面的 effect 自动跑。
  const applyRequest = useCallback((request: InAppValidationRequest) => {
    activeIpcRequestRef.current = { requestId: request.requestId };
    setHtmlSource(request.html);
    setStepsText(JSON.stringify(request.steps, null, 2));
    setResultsWithKeys([]);
    setError(null);
    setIframeReady(false);
    setDirty(false);
  }, [setResultsWithKeys]);

  // IPC 入口。脏保护：有手动编辑时挂起请求等用户选择，不得静默覆盖（旧实现 :127-135 直接覆盖）。
  useEffect(() => {
    if (!pendingRequest) return;
    if (dirty) {
      setHeldRequest(pendingRequest);
      return;
    }
    applyRequest(pendingRequest);
  }, [pendingRequest, dirty, applyRequest]);

  // 自动跑 IPC 请求并回传结果（仅当请求已被 apply 进 activeIpcRequestRef）。
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
        setResultsWithKeys(stepResults);
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
  }, [iframeReady, pendingRequest, setPendingRequest, setResultsWithKeys]);

  const handleLoadHeldRequest = useCallback(() => {
    if (!heldRequest) return;
    applyRequest(heldRequest);
    setHeldRequest(null);
  }, [heldRequest, applyRequest]);

  const handleKeepEditing = useCallback(() => {
    if (!heldRequest) return;
    const requestId = heldRequest.requestId;
    setHeldRequest(null);
    setPendingRequest(null);
    // 明确回传拒绝，main 端 runInAppValidation 的 promise 立即 reject。
    void ipcService.invoke(IPC_CHANNELS.IN_APP_VALIDATION_RESULT, {
      requestId,
      error: v.requestDeclined,
    });
  }, [heldRequest, setPendingRequest, v.requestDeclined]);

  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const failedCount = totalCount - passedCount;
  const allPassed = totalCount > 0 && passedCount === totalCount;
  const ipcActive = Boolean(pendingRequest) && !heldRequest;
  // 失败置顶：渲染顺序 = 失败卡片在前、通过在后（原始索引保留用于稳定 key）。
  const orderedResults = results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => Number(a.result.passed) - Number(b.result.passed));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="in-app-validation-workspace">
      {/* 工具条：运行 = 主操作（品牌色），Demo/重载 = 次级幽灵按钮 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-800 px-3">
        {ipcActive ? (
          <span className="flex items-center gap-1 rounded border border-badge-info/30 bg-sky-500/10 px-2 py-0.5 text-xs text-badge-info">
            <Radio className="h-3 w-3 animate-pulse" /> {v.ipcDriven}
          </span>
        ) : totalCount > 0 ? (
          <span
            className={`rounded border px-2 py-0.5 text-xs ${
              allPassed
                ? 'border-badge-success/30 bg-emerald-500/10 text-badge-success'
                : 'border-badge-danger/30 bg-rose-500/10 text-badge-danger'
            }`}
          >
            {v.passedBadge.replace('{passed}', String(passedCount)).replace('{total}', String(totalCount))}
          </span>
        ) : null}
        <div className="flex-1" />
        <button /* ds-allow:button: 验证工作台工具条次级按钮，12px 微尺寸行内样式，Button primitive 无对应变体 */
          type="button"
          onClick={loadDemo}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          {v.loadDemo}
        </button>
        <button /* ds-allow:button: 验证工作台工具条次级按钮，同上 */
          type="button"
          onClick={reloadIframe}
          disabled={running}
          className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          <RotateCw className="h-3 w-3" /> {v.reload}
        </button>
        <button /* ds-allow:button: 验证工作台主操作，品牌色实心按钮，Button primitive 无 12px 微尺寸变体 */
          type="button"
          onClick={runScript}
          disabled={running}
          className="flex items-center gap-1 rounded bg-primary-600 px-3 py-1 text-xs font-medium text-white hover:bg-primary-500 disabled:opacity-50"
        >
          <Play className="h-3 w-3" /> {running ? v.running : v.run}
        </button>
      </div>

      {/* 脏保护横幅：held 请求等用户选择，期间不覆盖编辑、不自动执行 */}
      {heldRequest && (
        <div
          className="flex shrink-0 items-center gap-3 border-b border-badge-warning/30 bg-amber-500/10 px-3 py-2"
          data-testid="in-app-validation-held-request"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-badge-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-badge-warning">{v.heldTitle}</div>
            <div className="text-[11px] text-badge-warning/70">{v.heldBody}</div>
          </div>
          <button /* ds-allow:button: 脏保护横幅主操作，品牌色实心按钮，Button primitive 无 12px 微尺寸变体 */
            type="button"
            onClick={handleLoadHeldRequest}
            className="rounded bg-primary-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-500"
          >
            {v.loadRequest}
          </button>
          <button /* ds-allow:button: 脏保护横幅次级操作，同上 */
            type="button"
            onClick={handleKeepEditing}
            className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {v.keepEditing}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 flex-col border-r border-slate-800">
          <div className="border-b border-slate-800 px-3 py-1 text-xs text-zinc-400">{v.iframePreviewLabel}</div>
          <iframe
            key={pendingRequest?.requestId || `manual-${manualReloadKey}`}
            ref={iframeRef}
            title="in-app-validation-preview"
            srcDoc={htmlSource}
            onLoad={() => setIframeReady(true)}
            className="flex-1 bg-zinc-950"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>

        <div className="flex w-[480px] flex-col">
          <div className="flex shrink-0 flex-col border-b border-slate-800">
            <div className="px-3 py-1 text-xs text-zinc-400">{v.htmlSourceLabel}</div>
            {/* 默认 12 行、可纵向拖拽加高（原 h-36 resize-none 压死高度） */}
            <textarea
              rows={12}
              className="resize-y bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 outline-hidden" /* ds-allow:color: HTML 源码编辑器由同一 textarea 的固定 bg-slate-900 承载深色画布 */
              value={htmlSource}
              onChange={(e) => {
                setHtmlSource(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="px-3 py-1 text-xs text-zinc-400">{v.stepsLabel}</div>
            <StepsJsonEditor
              value={stepsText}
              onChange={(next) => {
                setStepsText(next);
                setDirty(true);
              }}
              parseErrorTemplate={v.stepsInvalidJson}
            />
          </div>
          <div className="flex max-h-80 shrink-0 flex-col border-t border-slate-800 bg-slate-950 text-xs">
            {/* 失败汇总头：sticky 置顶，失败数一眼可见；卡片渲染顺序失败在前 */}
            {totalCount > 0 && (
              <div
                className="sticky top-0 flex items-center gap-2 border-b border-slate-800 bg-slate-950 px-3 py-1.5"
                data-testid="in-app-validation-result-summary"
              >
                <span className={allPassed ? 'text-badge-success' : 'text-zinc-300'}>
                  {v.passedBadge.replace('{passed}', String(passedCount)).replace('{total}', String(totalCount))}
                </span>
                <span className={failedCount > 0 ? 'text-badge-danger' : 'text-badge-success'}>
                  {failedCount > 0 ? v.failedSummary.replace('{n}', String(failedCount)) : v.allPassedSummary}
                </span>
              </div>
            )}
            <div className="overflow-auto px-3 py-2">
              {error && (
                <div className="mb-2 flex items-start gap-1 rounded bg-rose-900/40 p-2 text-badge-danger">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {results.length === 0 && !error && (
                <div className="space-y-2 text-slate-500">
                  <div>{v.emptyHint}</div>
                  <div>{v.emptySchemaTitle}</div>
                  <pre className="overflow-x-auto rounded border border-slate-800 bg-slate-900 p-2 text-[11px] text-slate-400" /* ds-allow:color: 空 schema 代码块的固定祖先是自身 bg-slate-900 */>{v.emptySchemaExample}</pre>
                </div>
              )}
              {orderedResults.map(({ result, index }) => (
                <div
                  key={resultKeysRef.current[index] ?? index}
                  className={`mb-2 rounded border p-2 ${
                    result.passed
                      ? 'border-badge-success bg-emerald-950/40'
                      : 'border-badge-danger bg-rose-950/40'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    {result.passed ? (
                      <CheckCircle2 className="h-3 w-3 text-badge-success" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-badge-danger" />
                    )}
                    <span className="font-medium">
                      {result.label || result.action.type}
                    </span>
                    <span className="ml-auto text-slate-500">{result.durationMs}ms</span>
                  </div>
                  {result.checks.length > 0 && (
                    /* checks 是「已通过的断言」，恒绿在失败步骤里会误读成全好——改中性色，
                       步骤级 pass/fail 已由边框与图标表达。 */
                    <ul className="mt-1 list-disc pl-4 text-zinc-400">
                      {result.checks.map((check, i) => (
                        <li key={i}>{check}</li>
                      ))}
                    </ul>
                  )}
                  {result.failures.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-badge-danger">
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
      </div>
    </div>
  );
}
