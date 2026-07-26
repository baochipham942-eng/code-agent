// ============================================================================
// TranscriptPartialLine —— 通话中的 partial 字幕行（B3）
//
// partial 只在通话态临时渲染，绝不进 projection（§7.5 单一生产者）：
// final 由 host 落库后经正常消息流回来，这里只显示「正在说」的那一截。
// ============================================================================

import React from 'react';
import { useVoiceCallStore } from '../../../stores/voiceCallStore';
import { useI18n } from '../../../hooks/useI18n';

export const TranscriptPartialLine: React.FC = () => {
  const { t } = useI18n();
  const phase = useVoiceCallStore((state) => state.phase);
  const partialUser = useVoiceCallStore((state) => state.partialUser);
  const partialAssistant = useVoiceCallStore((state) => state.partialAssistant);

  if (phase !== 'live') return null;
  const speaker = partialAssistant ? t.voice.transcript.assistant : partialUser ? t.voice.transcript.you : null;
  const text = partialAssistant || partialUser;
  if (!speaker || !text) return null;

  return (
    <div data-testid="voice-transcript-partial" className="mx-auto w-full max-w-3xl px-4 pb-1.5">
      <div className="flex items-baseline gap-2 rounded-lg bg-zinc-800/60 px-3 py-1.5 text-xs">
        <span className="shrink-0 font-medium text-zinc-300">{speaker}</span>
        <span className="min-w-0 truncate text-zinc-400">
          {text}
          <span className="motion-safe:animate-pulse">…</span>
        </span>
      </div>
    </div>
  );
};

export default TranscriptPartialLine;
