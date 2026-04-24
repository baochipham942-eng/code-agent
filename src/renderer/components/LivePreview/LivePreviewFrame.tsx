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
  const expectedOrigin = useMemo(() => getLivePreviewOrigin(devServerUrl), [devServerUrl]);

  const [bridgeReady, setBridgeReady] = useState(false);
  const [urlInput, setUrlInput] = useState(devServerUrl);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [cspSnippet, setCspSnippet] = useState<string>('');

  useEffect(() => {
    setUrlInput(devServerUrl);
    setBridgeReady(false);
    setFrameLoaded(false);
    setFrameError(null);
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
  }, [tabId, workingDirectory, setSelectedElement]);

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
    if (!iframeRef.current) return;
    // 用 cache-bust query 一次性 reload，不走 about:blank 中转。
    // 老做法 src='about:blank' → rAF → src=原 URL 有两个坑：
    //   1) Tauri WKWebView 的 frame-src CSP 对 about:blank 不稳定
    //   2) about:blank 秒加载会先触发一次 onLoad 让 frameLoaded=true，
    //      3s 诊断 timer 此时看 bridgeReady=false 会误报 "bridge 未报 ready"
    // 改成一次赋值一次 load，query 每次覆盖不堆叠。
    // 不清 selection：P3 (bridge 0.2.0) 之后 vg:ready 会带 restore-selection
    // 重新找到原元素高亮。用户想手动清请用 bridge 的 vg:clear-selection 或重开 tab。
    const base = iframeRef.current.src.replace(/([?&])_refresh=\d+&?/, '$1').replace(/[?&]$/, '');
    const sep = base.includes('?') ? '&' : '?';
    iframeRef.current.src = `${base}${sep}_refresh=${Date.now()}`;
    setBridgeReady(false);
    // 同步 reset frameLoaded，诊断 useEffect 的 6s 窗口从新 iframe 开始 load 起算，
    // 避免 old frameLoaded=true + new !bridgeReady 组合立刻误报 "bridge 未 ready"。
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

      {/* iframe */}
      <div className="flex-1 overflow-hidden bg-white relative">
        <iframe
          key={devServerUrl}
          ref={iframeRef}
          src={devServerUrl}
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
    </div>
  );
};

export default LivePreviewFrame;
