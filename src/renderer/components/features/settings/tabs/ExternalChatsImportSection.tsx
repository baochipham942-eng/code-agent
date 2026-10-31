// ============================================================================
// ExternalChatsImportSection — 设置页「从其他 AI 应用导入」的最近聊天一键导入卡
// ============================================================================
//
// N-EXTHISTORY-IMPORT-CHATS-HOST-FU1：独立于本页的三步导入流，一个按钮批量导入
// 最近 30 天的 Claude Code / Codex CLI 聊天（agentEngine 域 importRecentChats
// action，去重台账在宿主侧，重复点击不会产生重复会话）。结果只按 status 出大白话
// 文案：裸 reason 串（含源路径）只进宿主日志，绝不出现在页面 DOM——与技能结果块
// 同一条规矩。

import React, { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { RecentExternalChatImportResult } from '@shared/contract/agentEngine';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Toggle } from '../../../primitives';

type ExternalChatsImportCopy = ReturnType<
  typeof useI18n
>['t']['settings']['externalImport']['chatsImport'];

interface ChatsSyncState {
  mode: 'off' | 'on' | 'paused';
  lastRun?: { at: number; imported: number };
}

function summaryCounts(results: RecentExternalChatImportResult[]): Record<'imported' | 'already' | 'folderMissing' | 'failed', number> {
  return {
    imported: results.filter((item) => item.status === 'imported').length,
    already: results.filter((item) => item.status === 'already_imported').length,
    folderMissing: results.filter((item) => item.status === 'folder_missing').length,
    failed: results.filter((item) => item.status === 'failed').length,
  };
}

function summaryLine(copy: ExternalChatsImportCopy, counts: Record<'imported' | 'already' | 'folderMissing' | 'failed', number>): string {
  return copy.summary
    .replace('{imported}', String(counts.imported))
    .replace('{already}', String(counts.already))
    .replace('{folderMissing}', String(counts.folderMissing))
    .replace('{failed}', String(counts.failed));
}

export const ExternalChatsImportSection: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.externalImport.chatsImport;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [results, setResults] = useState<RecentExternalChatImportResult[] | null>(null);

  const [sync, setSync] = useState<ChatsSyncState>({ mode: 'off' });
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    ipcService
      .invokeDomain<ChatsSyncState>(IPC_DOMAINS.AGENT_ENGINE, 'getChatsSync')
      .then((state) => { if (alive && state) setSync(state); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const changeSync = async (mode: ChatsSyncState['mode']): Promise<void> => {
    setSyncBusy(true);
    setSyncFailed(false);
    try {
      const next = await ipcService.invokeDomain<ChatsSyncState>(
        IPC_DOMAINS.AGENT_ENGINE,
        'setChatsSync',
        { mode },
      );
      if (next) setSync(next);
      // 开启时宿主已同步一轮；有新导入则静默刷一次侧栏（同 runImport）。
      if (mode === 'on' && (next?.lastRun?.imported ?? 0) > 0) {
        void useSessionStore.getState().loadSessions({ silent: true }).catch(() => {});
      }
    } catch {
      setSyncFailed(true);
    } finally {
      setSyncBusy(false);
    }
  };

  const syncStatus = sync.mode === 'paused'
    ? copy.sync.statusPaused
    : sync.mode === 'on'
      ? (sync.lastRun
        ? copy.sync.statusOnLast
          .replace('{time}', new Date(sync.lastRun.at).toLocaleString())
          .replace('{count}', String(sync.lastRun.imported))
        : copy.sync.statusOn)
      : copy.sync.statusOff;

  const runImport = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      const data = await ipcService.invokeDomain<RecentExternalChatImportResult[]>(
        IPC_DOMAINS.AGENT_ENGINE,
        'importRecentChats',
      );
      setResults(data ?? []);
      // 宿主导入不广播 SESSION_LIST_UPDATED，侧栏项目组又派生自会话列表——
      // 真有新导入才静默刷一次（durableResume / teamClient 同款调用），
      // 全部已在 Neo / 零候选 / IPC 失败不刷；刷新被拒不翻错误态、结果照常显示。
      if ((data ?? []).some((item) => item.status === 'imported')) {
        void useSessionStore.getState().loadSessions({ silent: true }).catch(() => {});
      }
    } catch {
      // 原始错误串（可能带路径）不进页面，只给固定大白话；宿主侧已按 action 记日志。
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="external-chats-import"
      className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{copy.title}</div>
          <div className="mt-1 text-xs text-zinc-500">{copy.description}</div>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          onClick={() => void runImport()}
        >
          {busy ? copy.running : copy.cta}
        </Button>
      </div>

      <div className="mt-3 border-t border-zinc-700/70 pt-3" data-testid="external-chats-sync">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-200">{copy.sync.title}</div>
            <div className="mt-1 text-xs text-zinc-500">{copy.sync.description}</div>
            <div className="mt-1 text-xs text-zinc-400" data-testid="external-chats-sync-status">{syncStatus}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {sync.mode !== 'off' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={syncBusy}
                onClick={() => void changeSync(sync.mode === 'paused' ? 'on' : 'paused')}
              >
                {sync.mode === 'paused' ? copy.sync.resume : copy.sync.pause}
              </Button>
            )}
            <Toggle
              checked={sync.mode === 'on'}
              disabled={syncBusy}
              aria-label={copy.sync.toggleLabel}
              onChange={(checked) => void changeSync(checked ? 'on' : 'off')}
            />
          </div>
        </div>
        {syncFailed && (
          <div data-testid="external-chats-sync-error" className="mt-2 text-xs text-badge-danger">{copy.sync.failed}</div>
        )}
      </div>

      {failed && (
        <div
          data-testid="external-chats-import-error"
          className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-badge-danger"
        >
          {copy.failed}
        </div>
      )}

      {results && (
        <div className="mt-3 space-y-1" data-testid="external-chats-import-results">
          {results.length === 0 ? (
            <div className="text-xs text-zinc-500" data-testid="external-chats-import-empty">
              {copy.empty}
            </div>
          ) : (
            <>
              <div className="text-xs text-zinc-300" data-testid="external-chats-import-summary">
                {summaryLine(copy, summaryCounts(results))}
              </div>
              <div className="max-h-56 space-y-1 overflow-auto">
                {results.map((item) => (
                  <div
                    key={`${item.engine}:${item.sourceSessionId}`}
                    className="truncate text-[11px] text-zinc-500"
                    data-testid={`external-chats-import-row-${item.sourceSessionId}`}
                  >
                    {item.title} · {copy.engineNames[item.engine]} · {copy.statusLabels[item.status]}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
