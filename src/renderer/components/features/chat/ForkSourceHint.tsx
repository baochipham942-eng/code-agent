import React, { useCallback } from 'react';
import { GitFork } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSessionUIStore } from '../../../stores/sessionUIStore';
import type { SessionForkLineageSummary } from '@shared/contract/sessionFork';

interface ForkSourceHintProps {
  sessionId: string | null;
}

/**
 * 分叉子会话的轻量来源提示：挂在第一段用户输入上方，
 * 点击经 pendingSearchJump 管线跳回父会话并高亮锚点消息。
 * 取代原顶部 ForkLineageBar——失败/隔离等底层状态不在此暴露（不占前台）。
 */
export const ForkSourceHint: React.FC<ForkSourceHintProps> = ({ sessionId }) => {
  const { t } = useI18n();
  const forkLineage = useSessionStore((state) => {
    const session = state.sessions.find((item) => item.id === sessionId);
    return (session?.metadata?.forkLineage as SessionForkLineageSummary | undefined) ?? null;
  });  const parentTitle = useSessionStore((state) => {
    if (!forkLineage) return null;
    return state.sessions.find((item) => item.id === forkLineage.parentSessionId)?.title ?? null;
  });
  const switchSession = useSessionStore((state) => state.switchSession);
  const setPendingSearchJump = useSessionUIStore((state) => state.setPendingSearchJump);

  const handleJumpToSource = useCallback(() => {
    if (!forkLineage) return;
    setPendingSearchJump({
      sessionId: forkLineage.parentSessionId,
      messageId: forkLineage.sourceAnchorMessageId,
      query: '',
      createdAt: Date.now(),
    });
    void switchSession(forkLineage.parentSessionId);
  }, [forkLineage, setPendingSearchJump, switchSession]);

  if (!forkLineage) return null;

  const label = t.forkSourceHint.source
    .replace('{parentTitle}', parentTitle ?? forkLineage.parentSessionId)
    .replace('{anchorId}', forkLineage.sourceAnchorMessageId);

  return (
    <button /* ds-allow:button: 整行可点的轻量来源提示条（图标+截断文本左对齐），Button primitive 的居中动作按钮形状不适配 */
      type="button"
      onClick={handleJumpToSource}
      className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[11px] text-badge-accent/80 transition-colors hover:text-badge-accent"
    >
      <GitFork className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
};
