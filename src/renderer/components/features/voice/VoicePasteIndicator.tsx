import React from 'react';
import { useAppStore } from '@renderer/stores/appStore';

export const VoicePasteIndicator: React.FC = () => {
  const voicePasteStatus = useAppStore((s) => s.voicePasteStatus);

  if (voicePasteStatus === 'idle') return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex items-center gap-2 rounded-full bg-gray-900/90 px-4 py-2 text-white shadow-lg backdrop-blur-sm">
      {voicePasteStatus === 'recording' && (
        <>
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
          </span>
          <span className="text-sm font-medium">录音中... (Cmd+` 停止)</span>
        </>
      )}
      {voicePasteStatus === 'transcribing' && (
        <>
          <svg className="h-4 w-4 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-medium">转写中...</span>
        </>
      )}
      {voicePasteStatus === 'processing' && (
        <>
          <svg className="h-4 w-4 animate-spin text-green-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm font-medium">后处理中...</span>
        </>
      )}
    </div>
  );
};
