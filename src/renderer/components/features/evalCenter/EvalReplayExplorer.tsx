// ============================================================================
// EvalReplayExplorer - 评测中心「回放」tab
//
// 契约：
// - 左栏列出有可回放内容的会话（turnCount/messageCount > 0，按最近活动倒序），
//   右栏内嵌纯视图 ReplayAuditPanelView（与 ReplayAuditPanel 同一 IPC 数据源
//   REPLAY_GET_STRUCTURED_DATA）。
// - v1 取舍：不复用 Sidebar 的 SessionReplayDialog——它耦合 workflowRuns 合并与轨迹
//   评审流（replayDialog state 长在 Sidebar 里），整体搬进来成本大于收益；这里直接
//   拉数据喂纯视图，评审动作仍走会话行右键菜单的既有流程。
// - 深链：appStore.evalCenterReplaySessionId（会话行 hover 眼睛图标写入）在挂载时
//   消费一次作为初始选中，并立即 clearEvalCenterReplayTarget 清空。
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { Eye, ShieldCheck } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { StructuredReplay } from '@shared/contract/evaluation';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import { ReplayAuditPanelView } from '../audit/ReplayAuditPanel';

type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export const EvalReplayExplorer: React.FC = () => {
  const { t } = useI18n();
  const r = t.evalCenter.replay;
  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const deepLinkSessionId = useAppStore((state) => state.evalCenterReplaySessionId);
  const clearEvalCenterReplayTarget = useAppStore((state) => state.clearEvalCenterReplayTarget);

  const replayableSessions = useMemo(
    () => sessions
      .filter((session) => (session.turnCount ?? 0) > 0 || (session.messageCount ?? 0) > 0)
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [sessions],
  );

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [replay, setReplay] = useState<StructuredReplay | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // 深链消费：眼睛图标进入时预选对应会话，只消费一次。
  useEffect(() => {
    if (!deepLinkSessionId) return;
    setSelectedSessionId(deepLinkSessionId);
    clearEvalCenterReplayTarget();
  }, [deepLinkSessionId, clearEvalCenterReplayTarget]);

  useEffect(() => {
    if (!selectedSessionId) {
      setReplay(null);
      setStatus('idle');
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const result = await ipcService.invoke(
          IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA,
          selectedSessionId,
        ) as StructuredReplay | null;
        if (cancelled) return;
        setReplay(result);
        setStatus(result ? 'ready' : 'empty');
      } catch (err) {
        if (cancelled) return;
        setReplay(null);
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, refreshToken]);

  const selectedSession = replayableSessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <div className="flex min-h-0 flex-1" data-testid="eval-replay-explorer">
      <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex-1 overflow-y-auto p-2">
          {replayableSessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-zinc-600">{r.emptySessions}</div>
          ) : (
            replayableSessions.map((session) => {
              const isSelected = session.id === selectedSessionId;
              return (
                <button /* ds-allow:button: 回放会话列表行（role=listbox option 语义的自定义行），Button primitive 无列表行变体 */
                  key={session.id}
                  type="button"
                  onClick={() => setSelectedSessionId(session.id)}
                  data-testid={`eval-replay-session-${session.id}`}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    isSelected ? 'bg-zinc-700/60 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  <Eye className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                  <span className="min-w-0 flex-1 truncate">{getDisplaySessionTitle(session.title)}</span>
                  {session.id === currentSessionId && (
                    <span className="shrink-0 rounded border border-sky-500/30 bg-sky-500/10 px-1 py-0.5 text-[10px] text-sky-300">
                      {r.currentSessionBadge}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {selectedSessionId ? (
          <ReplayAuditPanelView
            replay={replay}
            sessionTitle={selectedSession ? getDisplaySessionTitle(selectedSession.title) : selectedSessionId}
            loading={status === 'loading'}
            error={error}
            onRefresh={() => setRefreshToken((value) => value + 1)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              {r.pickSession}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
