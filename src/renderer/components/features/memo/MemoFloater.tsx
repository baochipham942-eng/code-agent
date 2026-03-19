// ============================================================================
// MemoFloater - 全局热键唤起的快速输入浮窗
// 监听 Tauri 事件：memo:activate, memo:new_chat, memo:paste_context
// 自包含：通过 iact:send 事件发送消息，通过 sessionStore 创建新对话
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, X, Clipboard, MessageSquarePlus } from 'lucide-react';
import { isTauriMode } from '../../../utils/platform';
import { useSessionStore } from '../../../stores/sessionStore';

export const MemoFloater: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleNewChat = useCallback(async () => {
    await useSessionStore.getState().createSession('新对话');
    setIsVisible(false);
  }, []);

  const handleSend = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('iact:send', { detail: text }));
  }, []);

  // Listen for Tauri tray/shortcut events
  useEffect(() => {
    if (!isTauriMode()) return;

    const handleActivate = () => {
      setIsVisible(true);
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    const handleNewChatEvent = () => {
      handleNewChat();
    };

    const handlePasteContext = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text?.trim()) {
          setIsVisible(true);
          setValue(text);
          setTimeout(() => inputRef.current?.focus(), 100);
        }
      } catch {
        // Clipboard not available
      }
    };

    const listen = async () => {
      try {
        const { listen: tauriListen } = await import('@tauri-apps/api/event');
        const unlisten1 = await tauriListen('memo:activate', handleActivate);
        const unlisten2 = await tauriListen('memo:new_chat', handleNewChatEvent);
        const unlisten3 = await tauriListen('memo:paste_context', handlePasteContext);
        return () => {
          unlisten1();
          unlisten2();
          unlisten3();
        };
      } catch {
        return () => {};
      }
    };

    let cleanup: (() => void) | undefined;
    listen().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [handleNewChat]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed) {
      handleSend(trimmed);
      setValue('');
      setIsVisible(false);
    }
  }, [value, handleSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      setIsVisible(false);
    }
  }, [handleSubmit]);

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setIsVisible(false)}
      />

      {/* Floater */}
      <div className="relative w-full max-w-lg mx-4 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs text-zinc-500">Memo · Cmd+Shift+A</span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleNewChat}
              className="p-1 text-zinc-500 hover:text-zinc-300 rounded transition-colors"
              title="新建对话"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (text) setValue((prev) => prev ? `${prev}\n${text}` : text);
                } catch { /* ignore */ }
              }}
              className="p-1 text-zinc-500 hover:text-zinc-300 rounded transition-colors"
              title="粘贴剪贴板"
            >
              <Clipboard className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsVisible(false)}
              className="p-1 text-zinc-500 hover:text-zinc-300 rounded transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Input */}
        <div className="p-3">
          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            placeholder="输入消息或粘贴内容..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600 resize-none"
            autoFocus
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800">
          <span className="text-[10px] text-zinc-600">Enter 发送 · Shift+Enter 换行 · Esc 关闭</span>
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-primary-500/20 text-primary-300 rounded-md hover:bg-primary-500/30 transition-colors disabled:opacity-30"
          >
            <Send className="w-3 h-3" />
            发送
          </button>
        </div>
      </div>
    </div>
  );
};
