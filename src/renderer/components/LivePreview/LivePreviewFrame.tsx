// Live Preview Frame — 嵌入用户 dev server 的 iframe，订阅 bridge postMessage
// 协议与 vite-plugin-code-agent-bridge v0.1.0 对齐，见 src/shared/livePreview/protocol.ts
// MVP：iframe 加载 URL + 地址栏 + Refresh；点击事件写入 store 里的 selectedElement。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ExternalLink, Target, FileCode } from 'lucide-react';
import {
  isBridgeMessage,
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

  // 3 秒没 bridge ready 就提示诊断信息
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
    }, 3000);
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
        file: resolved.absolute,
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
        case 'vg:ready':
          setBridgeReady(true);
          break;
        case 'vg:select':
          void resolveAndSetSelectedElement(msg.payload);
          break;
        case 'vg:hover':
          // MVP 不处理 hover，后续可用于编辑器端预览联动
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [expectedOrigin, resolveAndSetSelectedElement]);

  const handleRefresh = useCallback(() => {
    if (!iframeRef.current) return;
    // 强制 reload：重新赋 src 比 contentWindow.location.reload() 跨域安全
    const src = iframeRef.current.src;
    iframeRef.current.src = 'about:blank';
    requestAnimationFrame(() => {
      if (iframeRef.current) iframeRef.current.src = src;
    });
    setBridgeReady(false);
    setSelectedElement(tabId, null);
  }, [tabId, setSelectedElement]);

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
