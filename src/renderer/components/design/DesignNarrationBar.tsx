import React from 'react';
import { CloseButton } from '../primitives';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasStore } from './designCanvasStore';

/**
 * 出图复述/验收条：动手前说要做什么（用户可据此打断），出完换成可核对的实际结果。
 *
 * 与错误条互斥——失败时复述被清掉，改由错误条承载失败收口；两者共用调用方那道 showErrorBar 闸，
 * 必须同生同死，否则会出现「复述说了要出图、失败陈述却被藏起来」的悬空态。
 * 自主运行横幅同样占 top-4，有它时本条下移让位。
 *
 * 自己订阅 store 而不是走 props：本条是自足的浮层，且 DesignCanvas.tsx 贴着 max-lines 1000 的门。
 */
export const DesignNarrationBar: React.FC<{
  /** 自主运行横幅占着 top-4 时下移让位。 */
  shiftedDown: boolean;
}> = ({ shiftedDown }) => {
  const { t } = useI18n();
  const narration = useDesignCanvasStore((s) => s.narration);
  const setNarration = useDesignCanvasStore((s) => s.setNarration);
  const error = useDesignCanvasStore((s) => s.error);
  if (!narration || error) return null;
  return (
    <div
      data-testid="design-canvas-narration-bar"
      className={`pointer-events-auto absolute left-1/2 z-40 flex w-[min(640px,92%)] -translate-x-1/2 items-start gap-2 rounded-xl border border-sky-500/30 bg-zinc-900/95 p-3 text-sm text-zinc-200 shadow-xl backdrop-blur ${
        shiftedDown ? 'top-16' : 'top-4'
      }`}
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed">{narration}</span>
      <CloseButton
        aria-label={t.imageNarration.dismiss}
        onClick={() => setNarration(null)}
        size="sm"
        className="rounded-md p-0.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
      />
    </div>
  );
};
