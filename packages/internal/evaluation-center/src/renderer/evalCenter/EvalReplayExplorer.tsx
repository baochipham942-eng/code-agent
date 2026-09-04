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
import { Eye, FilePlus2, ShieldCheck } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { StructuredReplay } from '@shared/contract/evaluation';
import ipcService from '@renderer/services/ipcService';
import { useSessionStore } from '@renderer/stores/sessionStore';
import { useEvalCenterStore } from '../stores/evalCenterStore';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { getDisplaySessionTitle } from '@renderer/utils/sessionPresentation';
import { ReplayAuditPanelView } from '../audit/ReplayAuditPanel';
import { Button } from '@renderer/components/primitives/Button';
import { EvalHarvestDialog } from './EvalHarvestDialog';

type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export const EvalReplayExplorer: React.FC = () => {
  const { t } = useEvaluationI18n();
  const r = t.evalCenter.replay;
  const h = t.evalCenter.harvest;
  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const deepLinkSessionId = useEvalCenterStore((state) => state.replaySessionId);
  const clearEvalCenterReplayTarget = useEvalCenterStore((state) => state.clearReplayTarget);

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
  // 「从会话转成题目」：勾选 ≥1 场后按钮才出现（对齐页 B7）。
  const [harvestSelection, setHarvestSelection] = useState<string[]>([]);
  const [harvestOpen, setHarvestOpen] = useState(false);

  const toggleHarvest = (sessionId: string) => {
    setHarvestSelection((previous) => (previous.includes(sessionId)
      ? previous.filter((id) => id !== sessionId)
      : [...previous, sessionId]));
  };

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
    <div className="flex min-h-0 flex-1 border-t border-zinc-800" data-testid="eval-replay-explorer">
      <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        {/* 列头：会话列表此前直接顶在页头下面、无标签无节奏（dogfood 报「样式失调」），
            补一行与页内其余列表同规格的列头 + 计数，行区再自管滚动。 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2.5">
          <span className="truncate text-xs font-medium text-zinc-400">{r.sessionListTitle}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">{replayableSessions.length}</span>
        </div>
        {harvestSelection.length > 0 && (
          <div className="shrink-0 border-b border-zinc-800 px-3 py-2">
            <Button
              size="sm"
              className="w-full"
              leftIcon={<FilePlus2 className="h-3.5 w-3.5" />}
              onClick={() => setHarvestOpen(true)}
              data-testid="eval-replay-harvest-open"
            >
              {h.openButton}
            </Button>
            <div className="mt-1 text-center text-[10px] text-zinc-600">
              {h.selectedCount.replace('{n}', String(harvestSelection.length))}
            </div>
          </div>
        )}
        <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {replayableSessions.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-zinc-600">{r.emptySessions}</div>
          ) : (
            replayableSessions.map((session) => {
              const isSelected = session.id === selectedSessionId;
              return (
                <div
                  key={session.id}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    isSelected ? 'bg-zinc-700/60 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={harvestSelection.includes(session.id)}
                    onChange={() => toggleHarvest(session.id)}
                    aria-label={h.selectSessions}
                    data-testid={`eval-replay-select-${session.id}`}
                  />
                  <button /* ds-allow:button: 回放会话列表行（role=listbox option 语义的自定义行），Button primitive 无列表行变体 */
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                    data-testid={`eval-replay-session-${session.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Eye className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                    <span className="min-w-0 flex-1 truncate">{getDisplaySessionTitle(session.title)}</span>
                    {session.id === currentSessionId && (
                      <span className="shrink-0 rounded border border-badge-info/30 bg-sky-500/10 px-1 py-0.5 text-[10px] text-badge-info">
                        {r.currentSessionBadge}
                      </span>
                    )}
                  </button>
                </div>
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

      {harvestOpen && (
        <EvalHarvestDialog
          sessionIds={harvestSelection}
          onClose={() => setHarvestOpen(false)}
          onOpenSession={(sessionId) => {
            setSelectedSessionId(sessionId);
            setHarvestOpen(false);
          }}
          onFinished={() => setHarvestSelection([])}
        />
      )}
    </div>
  );
};
