// ============================================================================
// TurnCompactionMarker - 压缩摘要的操作行标记
// 压缩摘要不再以整条横幅插在消息流里（2026-08-21 爸拍板：太扎眼），降级为
// 压缩点所在轮操作行最右端的一枚 Archive 标记，点开可读摘要原文。
// ============================================================================

import React from 'react';
import { Archive } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';

interface Props {
  expanded: boolean;
  onToggle: () => void;
}

export const TurnCompactionMarker: React.FC<Props> = ({ expanded, onToggle }) => {
  const { t } = useI18n();
  return (
    <button /* ds-allow:button: 与操作行其他图标同形的紧凑标记按钮 */
      type="button"
      data-testid="turn-compaction-marker"
      aria-label={t.turnCard.contextCompacted}
      title={t.turnCard.contextCompacted}
      aria-expanded={expanded}
      onClick={onToggle}
      className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-zinc-500 transition-colors hover:border-badge-warning/40 hover:bg-amber-500/10 hover:text-badge-warning focus:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
    >
      <Archive className="h-3.5 w-3.5" />
    </button>
  );
};
