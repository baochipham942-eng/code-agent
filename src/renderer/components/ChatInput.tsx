// ============================================================================
// ChatInput - Message Input Component (Enhanced UI/UX)
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, Loader2, Sparkles, Command, CornerDownLeft } from 'lucide-react';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (value.trim() && !disabled) {
      onSend(value);
      setValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <div className="border-t border-zinc-800/50 bg-gradient-to-t from-surface-950 to-surface-950/80 backdrop-blur-sm p-4">
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
        <div
          className={`relative flex items-end gap-2 bg-zinc-800/60 rounded-2xl border transition-all duration-300 ${
            isFocused
              ? 'border-primary-500/40 shadow-lg shadow-primary-500/5 ring-1 ring-primary-500/20'
              : 'border-zinc-700/50 hover:border-zinc-600/50'
          }`}
        >
          {/* Attachment button */}
          <button
            type="button"
            className="p-2.5 ml-2 mb-2 rounded-xl hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition-all duration-200"
            title="附加文件（即将推出）"
          >
            <Paperclip className="w-5 h-5" />
          </button>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="问我任何关于代码的问题..."
            disabled={disabled}
            rows={1}
            className="flex-1 bg-transparent py-3.5 px-1 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none disabled:opacity-50 max-h-[200px] leading-relaxed"
          />

          {/* Send button with animation */}
          <button
            type="submit"
            disabled={disabled || !hasContent}
            className={`p-2.5 mr-2 mb-2 rounded-xl text-white transition-all duration-300 ${
              hasContent && !disabled
                ? 'bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400 shadow-lg shadow-primary-500/20 hover:shadow-primary-500/30 scale-100 hover:scale-105'
                : 'bg-zinc-700/50 cursor-not-allowed scale-95 opacity-60'
            }`}
          >
            {disabled ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className={`w-5 h-5 transition-transform duration-200 ${hasContent ? '-rotate-45' : ''}`} />
            )}
          </button>
        </div>

        {/* Hints */}
        <div className="flex items-center justify-between mt-2.5 px-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <kbd className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 font-mono text-2xs border border-zinc-700/50">
                <CornerDownLeft className="w-3 h-3 inline" />
              </kbd>
              <span>发送</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <kbd className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 font-mono text-2xs border border-zinc-700/50">
                Shift
              </kbd>
              <span>+</span>
              <kbd className="px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 font-mono text-2xs border border-zinc-700/50">
                <CornerDownLeft className="w-3 h-3 inline" />
              </kbd>
              <span>换行</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Sparkles className="w-3 h-3 text-primary-400" />
            <span>由 DeepSeek 驱动</span>
          </div>
        </div>
      </form>
    </div>
  );
};
