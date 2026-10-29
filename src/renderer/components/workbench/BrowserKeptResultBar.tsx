import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { Button } from '../primitives';
import {
  adoptKeptResultPage,
  getKeptResultPage,
  type KeptResultPage,
} from '../../services/userBrowserLink';
import { openHttpLinkInRailAsync } from '../../services/userBrowserLink';

// N-BROWSER-KEEP-RESULT-PAGE：agent run 终态时叠加在留影/摘要卡底部的结果页条。
// 三态：none（不渲染）/ kept（窗还活着，一键认领接上活页继续操作）/ closed（窗已被
// 闲置回收或关闭，只留 URL 供一键重开——重开不恢复表单内容）。

/** 终态可见期间的低频轮询：30 分钟闲置回收发生时把「已保留」翻成「已关闭」。 */
const KEPT_STATE_POLL_MS = 30_000;

type KeptCopy = ReturnType<typeof useI18n>['t']['workbenchTabs']['agentWindow']['keptResult'];

function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    vars[key] !== undefined ? vars[key] : match
  ));
}

export interface BrowserKeptResultBarProps {
  conversationId: string | null | undefined;
  workspace: string | null | undefined;
}

export const BrowserKeptResultBar: React.FC<BrowserKeptResultBarProps> = ({
  conversationId,
  workspace,
}) => {
  const { t } = useI18n();
  const copy: KeptCopy = t.workbenchTabs.agentWindow.keptResult;
  const [kept, setKept] = useState<KeptResultPage>({ state: 'none', url: null, title: null });
  const [busy, setBusy] = useState<'adopt' | 'reopen' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await getKeptResultPage(conversationId);
    if (mountedRef.current) setKept(next);
  }, [conversationId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), KEPT_STATE_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const onAdopt = useCallback(async () => {
    if (!conversationId) return;
    setBusy('adopt');
    setError(null);
    try {
      await adoptKeptResultPage({ conversationId, workspace });
      // 认领成功后活跃 browser surface 会话接管画面，本条随终态消失。
    } catch (caught) {
      setError(formatTemplate(copy.adoptFailed, {
        error: caught instanceof Error ? caught.message : String(caught),
      }));
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [conversationId, workspace, copy.adoptFailed, refresh]);

  const onReopen = useCallback(async () => {
    if (!kept.url || !conversationId) return;
    setBusy('reopen');
    setError(null);
    try {
      await openHttpLinkInRailAsync({ href: kept.url, conversationId, workspace });
    } catch (caught) {
      setError(formatTemplate(copy.reopenFailed, {
        error: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [kept.url, conversationId, workspace, copy.reopenFailed]);

  if (kept.state === 'none') return null;

  return (
    <div
      data-testid={`browser-kept-result-bar-${kept.state}`}
      className="absolute bottom-3 left-1/2 z-10 flex w-[min(420px,calc(100%-24px))] -translate-x-1/2 flex-col items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2.5 text-center shadow-lg"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-100">
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-badge-info" />
        {kept.state === 'kept' ? copy.keptTitle : copy.closedTitle}
      </div>
      <div className="max-w-full truncate text-[11px] text-zinc-400" title={kept.url ?? undefined}>
        {kept.title || kept.url}
      </div>
      <div className="max-w-full text-[11px] leading-relaxed text-zinc-500">
        {kept.state === 'kept' ? copy.keptHint : copy.keptClosedHint}
      </div>
      {kept.state === 'kept' ? (
        <Button
          variant="primary"
          size="sm"
          loading={busy === 'adopt'}
          disabled={busy !== null}
          onClick={() => void onAdopt()}
          data-testid="browser-kept-result-adopt"
        >
          {copy.keptOpen}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          loading={busy === 'reopen'}
          disabled={busy !== null || !kept.url}
          onClick={() => void onReopen()}
          data-testid="browser-kept-result-reopen"
        >
          {copy.reopen}
        </Button>
      )}
      {error && (
        <div className="max-w-full text-[11px] leading-relaxed text-badge-danger">{error}</div>
      )}
    </div>
  );
};
