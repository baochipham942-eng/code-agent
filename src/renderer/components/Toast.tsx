// ============================================================================
// Toast - Global toast notification component
// ============================================================================

import React from 'react';
import { useToastStore, type ToastType } from '../hooks/useToast';

const ICON_MAP: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

const COLOR_MAP: Record<ToastType, string> = {
  success: 'border-green-500/40 text-green-400',
  error: 'border-red-500/40 text-red-400',
  info: 'border-blue-500/40 text-blue-400',
  warning: 'border-yellow-500/40 text-yellow-400',
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 px-3 py-2.5 bg-zinc-800 border rounded-lg shadow-lg animate-in slide-in-from-right-5 fade-in duration-200 ${COLOR_MAP[t.type]}`}
          role="alert"
        >
          <span className="text-sm font-bold shrink-0 mt-0.5">{ICON_MAP[t.type]}</span>
          <span className="text-sm text-zinc-200 break-words">{t.message}</span>
          <button
            onClick={() => removeToast(t.id)}
            className="ml-auto text-zinc-500 hover:text-zinc-300 text-xs shrink-0"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};
