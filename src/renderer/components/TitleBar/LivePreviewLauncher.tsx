// Live Preview 顶栏入口：B+ IA 调整把 Live Preview 从 ChatInput 能力 popover
// 挪到 TitleBar 跟工作目录绑定显示 — 这是个跟 working dir 强相关的工具，
// 不是每条 turn 都要看的 ChatInput 元素。
//
// 点击 Eye 按钮弹小 popover 输入 dev server URL（默认 localhost:5175），
// Open 触发全局 window.__openLivePreview。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';

const DEFAULT_LIVE_PREVIEW_URL = 'http://localhost:5175/';

export const LivePreviewLauncher: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(DEFAULT_LIVE_PREVIEW_URL);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleOpen = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    void window.__openLivePreview?.(trimmed);
    setOpen(false);
  }, [url]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative window-no-drag">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="打开 Live Preview"
        aria-label="Live Preview"
        aria-expanded={open}
        className="inline-flex items-center justify-center h-7 w-7 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-colors"
      >
        <Eye className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-lg border border-white/[0.1] bg-zinc-900/95 backdrop-blur p-3 shadow-xl">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            <Eye className="w-3 h-3" />
            <span>Live Preview</span>
          </div>
          <div className="flex gap-1">
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleOpen(); } }}
              placeholder={DEFAULT_LIVE_PREVIEW_URL}
              className="flex-1 min-w-0 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 outline-none focus:bg-white/[0.06]"
            />
            <button
              type="button"
              onClick={handleOpen}
              className="flex-shrink-0 rounded-md bg-primary-500/15 px-3 py-1.5 text-xs text-primary-200 transition-colors hover:bg-primary-500/25"
            >
              Open
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
