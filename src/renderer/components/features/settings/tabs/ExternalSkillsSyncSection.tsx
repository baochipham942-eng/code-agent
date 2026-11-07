// ============================================================================
// ExternalSkillsSyncSection — 「保持技能同步」卡（N-EXTHISTORY-IMPORT-SYNC-CONTENT-SKILLS）
// ============================================================================
//
// 启动时把 Codex / Cursor 新增的技能自动复制进 Neo（agentEngine 域 getSkillsSync /
// setSkillsSync）。页面只出大白话状态，不渲染原因码或路径。

import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { formatDateTime } from '../../../../utils/formatDateTime';
import { Button, Toggle } from '../../../primitives';

interface SkillsSyncState {
  mode: 'off' | 'on' | 'paused';
  lastRun?: { at: number; imported: number; keptNeo: number };
}

export const ExternalSkillsSyncSection: React.FC = () => {
  const { t, language } = useI18n();
  const copy = t.settings.externalImport.skillsSync;
  const [sync, setSync] = useState<SkillsSyncState>({ mode: 'off' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    ipcService
      .invokeDomain<SkillsSyncState>(IPC_DOMAINS.AGENT_ENGINE, 'getSkillsSync')
      .then((state) => { if (alive && state) setSync(state); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const changeSync = async (mode: SkillsSyncState['mode']): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await ipcService.invokeDomain<SkillsSyncState>(
        IPC_DOMAINS.AGENT_ENGINE,
        'setSkillsSync',
        { mode },
      );
      if (next) setSync(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const status = sync.mode === 'paused'
    ? copy.statusPaused
    : sync.mode === 'on'
      ? (sync.lastRun
        ? copy.statusOnLast
          .replace('{time}', formatDateTime(sync.lastRun.at, language))
          .replace('{count}', String(sync.lastRun.imported))
        : copy.statusOn)
      : copy.statusOff;
  const keptNeo = sync.mode === 'on' ? (sync.lastRun?.keptNeo ?? 0) : 0;

  return (
    <div
      data-testid="external-skills-sync"
      className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{copy.title}</div>
          <div className="mt-1 text-xs text-zinc-500">{copy.description}</div>
          <div className="mt-1 text-xs text-zinc-400" data-testid="external-skills-sync-status">{status}</div>
          {keptNeo > 0 && (
            <div className="mt-1 text-xs text-zinc-500" data-testid="external-skills-sync-kept-neo">
              {copy.keptNeoLine.replace('{count}', String(keptNeo))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {sync.mode !== 'off' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void changeSync(sync.mode === 'paused' ? 'on' : 'paused')}
            >
              {sync.mode === 'paused' ? copy.resume : copy.pause}
            </Button>
          )}
          <Toggle
            checked={sync.mode === 'on'}
            disabled={busy}
            aria-label={copy.toggleLabel}
            onChange={(checked) => void changeSync(checked ? 'on' : 'off')}
          />
        </div>
      </div>
      {failed && (
        <div data-testid="external-skills-sync-error" className="mt-2 text-xs text-badge-danger">{copy.failed}</div>
      )}
    </div>
  );
};
