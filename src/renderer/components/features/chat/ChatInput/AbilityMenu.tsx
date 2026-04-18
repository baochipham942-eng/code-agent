// ============================================================================
// AbilityMenu — ChatInput 工具栏里的能力 popover：Routing + Browser
// ============================================================================
//
// 把原来挂在 InlineWorkbenchBar 上的 Routing 三 pill 和 Browser 三 pill 收到这个
// popover 里。点击触发按钮展开；外部点击 / ESC 关闭。
//
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch, Globe } from 'lucide-react';
import type { BrowserSessionMode, ConversationRoutingMode } from '@shared/contract/conversationEnvelope';
import { useComposerStore } from '../../../../stores/composerStore';

const ROUTING_LABELS: Record<ConversationRoutingMode, string> = {
  auto: 'Auto',
  direct: 'Direct',
  parallel: 'Parallel',
};

const BROWSER_LABELS: Record<BrowserSessionMode, string> = {
  none: 'Off',
  managed: 'Managed',
  desktop: 'Desktop',
};

interface AbilityMenuProps {
  disabled?: boolean;
}

export const AbilityMenu: React.FC<AbilityMenuProps> = ({ disabled = false }) => {
  const routingMode = useComposerStore((state) => state.routingMode);
  const setRoutingMode = useComposerStore((state) => state.setRoutingMode);
  const browserSessionMode = useComposerStore((state) => state.browserSessionMode);
  const setBrowserSessionMode = useComposerStore((state) => state.setBrowserSessionMode);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = useCallback(() => {
    const parts: string[] = [];
    if (routingMode !== 'auto') parts.push(ROUTING_LABELS[routingMode]);
    if (browserSessionMode !== 'none') parts.push(BROWSER_LABELS[browserSessionMode]);
    return parts.length === 0 ? '能力' : parts.join(' · ');
  }, [browserSessionMode, routingMode]);

  const hasActive = routingMode !== 'auto' || browserSessionMode !== 'none';

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={`inline-flex items-center gap-1 h-8 rounded-lg px-2 text-xs transition-colors ${
          hasActive
            ? 'bg-primary-500/15 text-primary-200 hover:bg-primary-500/20'
            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        aria-label="能力"
        title="Routing / Browser 配置"
      >
        <GitBranch className="w-3.5 h-3.5" />
        <span className="max-w-[140px] truncate">{summary()}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-3 shadow-xl backdrop-blur z-30">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <GitBranch className="w-3 h-3" />
            Routing
          </div>
          <div className="mb-3 grid grid-cols-3 gap-1">
            {(['auto', 'direct', 'parallel'] as ConversationRoutingMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRoutingMode(mode)}
                className={`rounded-md px-2 py-1.5 text-xs transition-colors ${
                  routingMode === mode
                    ? 'bg-primary-500/20 text-primary-200'
                    : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                }`}
              >
                {ROUTING_LABELS[mode]}
              </button>
            ))}
          </div>

          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <Globe className="w-3 h-3" />
            Browser
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(['none', 'managed', 'desktop'] as BrowserSessionMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setBrowserSessionMode(mode)}
                className={`rounded-md px-2 py-1.5 text-xs transition-colors ${
                  browserSessionMode === mode
                    ? 'bg-primary-500/20 text-primary-200'
                    : 'bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                }`}
              >
                {BROWSER_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AbilityMenu;
