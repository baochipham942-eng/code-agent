// Live Preview Frame — 嵌入用户 dev server 的 iframe，订阅 bridge postMessage
// 协议与 vite-plugin-code-agent-bridge v0.2.0 对齐，见 src/shared/livePreview/protocol.ts
// 0.2.0: 支持 HMR 回流恢复 —— vg:ready 后若 appStore 还有 selection，发
// vg:restore-selection 请求 bridge 反查 DOM 重新高亮；匹配失败发 vg:selection-stale
// 由前端清 store。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ExternalLink, Target, FileCode } from 'lucide-react';
import {
  isBridgeMessage,
  MESSAGE_SOURCE_PARENT,
  type SelectedElementInfo,
} from '../../../shared/livePreview/protocol';
import { IPC_DOMAINS } from '../../../shared/ipc';
import { useAppStore, type LivePreviewSelectedElement } from '../../stores/appStore';
import { invokeDomain } from '../../services/ipcService';
import { TweakPanel } from './TweakPanel';

interface Props {
  tabId: string;
  devServerUrl: string;
}

const toSelectedElement = (info: SelectedElementInfo): LivePreviewSelectedElement => ({
  file: info.location.file,
  relativeFile: info.location.file,
  line: info.location.line,
  column: info.location.column,
  tag: info.tag,
  text: info.text,
  rect: info.rect,
  componentName: info.componentName,
  // V2-B (protocol 0.3.0) — pre-0.3 bridge 不发这两个字段，直接 undefined
  className: info.className,
  computedStyle: info.computedStyle,
});

interface ResolvedSourceLocation {
  absolute: string;
  relative: string;
  exists: boolean;
}

export function getLivePreviewOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isTrustedLivePreviewBridgeEvent(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  expectedSource: unknown,
  expectedOrigin: string | null,
): boolean {
  if (!isBridgeMessage(event.data)) return false;
  if (!expectedSource || event.source !== expectedSource) return false;
  if (!expectedOrigin || event.origin !== expectedOrigin) return false;
  return true;
}

export const LivePreviewFrame: React.FC<Props> = ({ tabId, devServerUrl }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setSelectedElement = useAppStore((s) => s.setSelectedElement);
  const jumpToFileLine = useAppStore((s) => s.jumpToFileLine);
  const workingDirectory = useAppStore((s) => s.workingDirectory);
  const selectedElement = useAppStore((s) => {
    const tab = s.previewTabs.find((t) => t.id === tabId);
    return tab?.selectedElement ?? null;
  });
  // V2-A: 当前 tab 的 dev server session id，传给 resolveSourceLocation
  // 让主进程用 manager.get(sessionId).projectPath 当 baseDir，不再依赖
  // 用户手动设 working directory（V1 旧链路只能用 cwd 算 baseDir 经常错）
  const devServerSessionId = useAppStore((s) => {
    const tab = s.previewTabs.find((t) => t.id === tabId);
    return tab?.devServerSessionId ?? null;
  });
  const expectedOrigin = useMemo(() => getLivePreviewOrigin(devServerUrl), [devServerUrl]);

  const [bridgeReady, setBridgeReady] = useState(false);
  const [urlInput, setUrlInput] = useState(devServerUrl);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [cspSnippet, setCspSnippet] = useState<string>('');
  // Refresh nonce：受控 src 的真相源。改 DOM src 直接 mutate 会被 React
  // rerender 矫正回 devServerUrl 导致 iframe double-load + contentWindow race。
  const [refreshNonce, setRefreshNonce] = useState(0);
  // V2-B TweakPanel 折叠状态（默认展开，让用户立刻看到能力）
  const [tweakCollapsed, setTweakCollapsed] = useState(false);

  const iframeSrc = useMemo(() => {
    if (refreshNonce === 0) return devServerUrl;
    const base = devServerUrl.replace(/([?&])_refresh=\d+&?/, '$1').replace(/[?&]$/, '');
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}_refresh=${refreshNonce}`;
  }, [devServerUrl, refreshNonce]);

  useEffect(() => {
    setUrlInput(devServerUrl);
    setBridgeReady(false);
    setFrameLoaded(false);
    setFrameError(null);
    setRefreshNonce(0);
    setSelectedElement(tabId, null);
  }, [devServerUrl, tabId, setSelectedElement]);

  // 读当前页面生效的 CSP（Tauri 把 tauri.conf.json 的 csp 注入成 meta tag）
  useEffect(() => {
    const metas = Array.from(document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'));
    const contents = metas.map((m) => m.getAttribute('content') ?? '').join(' || ');
    const m = /frame-src[^;]*/i.exec(contents);
    setCspSnippet(m ? m[0] : contents ? 'frame-src 未在 meta CSP 中' : 'meta CSP 未注入（可能通过 HTTP header）');
  }, []);

  // 6 秒没 bridge ready 就提示诊断信息。放宽到 6s 是因为 Tauri WKWebView 下
  // iframe reload → bridge inject → postMessage 链路偶尔比 Chrome 慢，3s 会误报。
  useEffect(() => {
    if (bridgeReady) return;
    const timer = setTimeout(() => {
      if (!bridgeReady && frameLoaded) {
        setFrameError(
          'iframe 加载完成但 bridge 未报 ready —— 可能 spike-app 未装 vite-plugin-code-agent-bridge，或 bridge runtime 未注入',
        );
      } else if (!frameLoaded) {
        setFrameError(
          'iframe 未能加载 —— 检查：1) spike-app dev server 在否 2) Tauri CSP frame-src 是否允许 localhost 3) 端口是否正确',
        );
      }
    }, 6000);
    return () => clearTimeout(timer);
  }, [bridgeReady, frameLoaded]);

  const resolveAndSetSelectedElement = useCallback(async (info: SelectedElementInfo) => {
    try {
      const resolved = await invokeDomain<ResolvedSourceLocation>(
        IPC_DOMAINS.LIVE_PREVIEW,
        'resolveSourceLocation',
        {
          file: info.location.file,
          // sessionId 优先（manager 自起的 dev server projectPath 最准）；
          // 没 session 时 fallback 到用户的 working directory
          devServerSessionId: devServerSessionId ?? undefined,
          projectRoot: workingDirectory || undefined,
        },
      );

      if (!resolved.exists) {
        setFrameError(`bridge 源码定位失败：${resolved.relative} 不存在`);
        return;
      }

      setSelectedElement(tabId, {
        ...toSelectedElement(info),
        // info.location.file 是 bridge 注入的 relative path，resolved.absolute 是
        // IPC 规范化后的绝对路径。两个都存：composer 注入 envelope 用 absolute
        // （下游工具跨进程消费方便），vg:restore-selection 反查 DOM 用 relative
        // （bridge 注入 DOM 的 data-code-agent-source 就是 relative）。
        file: resolved.absolute,
        relativeFile: info.location.file,
      });
    } catch (err) {
      setFrameError(`bridge 源码定位被拒绝：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [tabId, workingDirectory, setSelectedElement, devServerSessionId]);

  // 监听 iframe 发来的 bridge 消息
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!isTrustedLivePreviewBridgeEvent(e, iframeRef.current?.contentWindow, expectedOrigin)) return;
      const msg = e.data;
      switch (msg.type) {
        case 'vg:ready': {
          setBridgeReady(true);
          // 诊断 timer 若已误报 frameError（例如 Tauri 下 bridge 比 6s 晚报 ready），
          // 这里 ready 一来立刻清错误，让 UI 自恢复。
          setFrameError(null);
          // 0.2.0 HMR 回流恢复：iframe 重新挂载 bridge 后，若 appStore 还有
          // selection（用户没主动清），让 bridge 按 source location 反查 DOM 重高亮。
          // 用 getState() 而非 selector 依赖，避免 handler closure 追过期值。
          const active = useAppStore.getState().previewTabs.find((t) => t.id === tabId);
          const sel = active?.selectedElement;
          if (sel && expectedOrigin && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                source: MESSAGE_SOURCE_PARENT,
                type: 'vg:restore-selection',
                location: { file: sel.relativeFile, line: sel.line, column: sel.column },
              },
              expectedOrigin,
            );
          }
          break;
        }
        case 'vg:select':
          void resolveAndSetSelectedElement(msg.payload);
          break;
        case 'vg:hover':
          // MVP 不处理 hover，后续可用于编辑器端预览联动
          break;
        case 'vg:selection-stale':
          // bridge 说目标元素已找不到（被删、或 source location 漂移到不可识别）。
          // 前端清 selection 让 UI 回到未选中态，避免用户看到底部条亮着但 iframe 里没框。
          setSelectedElement(tabId, null);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [expectedOrigin, tabId, resolveAndSetSelectedElement, setSelectedElement]);

  const handleRefresh = useCallback(() => {
    // 通过 React state 推 refreshNonce 变更 iframeSrc（受控），让 iframe 重新 load。
    // 绝对不要 iframeRef.current.src = ... 直接改 DOM：src 是受控 prop，
    // React 下一轮 rerender 会把 DOM src 矫正回 devServerUrl，导致 double-load
    // + contentWindow race，P3 restore 链路瞎掉。
    // 不清 selection：P3 (bridge 0.2.0) 之后 vg:ready 会带 restore-selection
    // 重新找到原元素高亮。
    setRefreshNonce(Date.now());
    setBridgeReady(false);
    setFrameLoaded(false);
    setFrameError(null);
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.open(devServerUrl, '_blank', 'noopener');
  }, [devServerUrl]);

  const handlePing = useCallback(() => {
    if (!expectedOrigin) {
      setFrameError('dev server URL 无效，无法发送 bridge ping');
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(
      { source: 'vg:parent', type: 'vg:ping' },
      expectedOrigin,
    );
  }, [expectedOrigin]);

  const displayFile = useMemo(() => {
    if (!selectedElement) return null;
    return `${selectedElement.file}:${selectedElement.line}:${selectedElement.column}`;
  }, [selectedElement]);

  return (
    <div className="flex flex-col h-full bg-zinc-900">
      {/* 地址栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 bg-zinc-800">
        <span
          className={`w-2 h-2 rounded-full ${bridgeReady ? 'bg-emerald-400' : 'bg-zinc-500'}`}
          title={bridgeReady ? 'Bridge connected' : 'Waiting for bridge...'}
        />
        <input
          type="text"
          readOnly
          value={urlInput}
          className="flex-1 px-2 py-1 text-xs bg-zinc-900 text-zinc-300 border border-zinc-700 rounded font-mono"
        />
        <button
          onClick={handleRefresh}
          className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200"
          title="刷新"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        <button
          onClick={handlePing}
          className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200"
          title="测试 bridge"
        >
          <Target className="w-4 h-4" />
        </button>
        <button
          onClick={handleOpenExternal}
          className="p-1.5 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200"
          title="在默认浏览器打开"
        >
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>

      {/* 选中提示条 */}
      {displayFile && selectedElement && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-primary-500/10 border-b border-primary-500/30 text-primary-200 font-mono">
          <span className="text-primary-400">selected</span>
          <span className="text-zinc-400">&lt;{selectedElement.tag}&gt;</span>
          <span className="text-primary-200">{displayFile}</span>
          <button
            className="ml-2 flex items-center gap-1 px-2 py-0.5 rounded bg-primary-500/20 hover:bg-primary-500/30 text-primary-100"
            onClick={() => jumpToFileLine(selectedElement.file, selectedElement.line)}
            title="在编辑器打开并跳转到该行（需 workingDirectory 设为项目根）"
          >
            <FileCode className="w-3 h-3" />
            跳转源码
          </button>
          <button
            className="ml-auto text-zinc-400 hover:text-zinc-200"
            onClick={() => setSelectedElement(tabId, null)}
          >
            清除
          </button>
        </div>
      )}

      {/* 诊断条 */}
      {frameError && (
        <div className="px-3 py-2 text-xs bg-amber-500/10 border-b border-amber-500/30 text-amber-200 space-y-1">
          <div className="font-mono">⚠ {frameError}</div>
          <div className="font-mono text-amber-300/80">生效 CSP: {cspSnippet}</div>
        </div>
      )}

      {/* iframe + TweakPanel 抽屉（V2-B） */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden bg-white relative">
          <iframe
            key={devServerUrl}
            ref={iframeRef}
            src={iframeSrc}
            title="Live Preview"
            className="w-full h-full border-0"
            onLoad={() => {
              setFrameLoaded(true);
              setFrameError(null);
            }}
            onError={() => {
              setFrameError('iframe onError 触发（可能 CSP 拒绝、URL 错误、或跨域阻塞）');
            }}
          />
          {!frameLoaded && !frameError && (
            <div className="absolute inset-0 flex items-center justify-center bg-white text-zinc-400 text-sm">
              正在加载 {devServerUrl} ...
            </div>
          )}
        </div>
        {selectedElement && (
          <TweakPanel
            selected={selectedElement}
            collapsed={tweakCollapsed}
            onToggleCollapsed={() => setTweakCollapsed((v) => !v)}
          />
        )}
      </div>
    </div>
  );
};

export default LivePreviewFrame;
