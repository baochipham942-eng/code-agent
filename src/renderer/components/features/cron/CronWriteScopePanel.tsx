// ============================================================================
// CronWriteScopePanel —— 任务详情的「文件写入授权」面板（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1）
// ============================================================================
// 三态（与任务书 walkthrough 逐字对齐）：
//   未授权+文件夹可解析：「文件写入：不允许。需要保存文件时会停下来等你确认。」+ 允许按钮
//   已授权：「已允许在 <folder> 里保存文件」+ 撤销按钮
//   未授权+解析不出文件夹：提示先在对话里选工作文件夹（不出死按钮）
// 候选文件夹与 host 授权/会话创建共用 shared/cronWriteScope.cronWriteScopeFolder，
// 展示的文件夹 = 授权会落库的文件夹。
// ============================================================================

import React, { useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { CronJobDefinition } from '@shared/contract';
import {
  CRON_WRITE_SCOPE_NO_FOLDER,
  cronSourceSessionIdFromDefinition,
  cronWriteScopeFolder,
  writeGrantRootFromMetadata,
} from '@shared/cronWriteScope';
import { useI18n } from '../../../hooks/useI18n';
import { useCronStore } from '../../../stores/cronStore';
import { useSessionStore } from '../../../stores/sessionStore';
import cronClient from '../../../services/cronClient';
import { Button } from '../../primitives/Button';

function applyJobToStore(job: CronJobDefinition): void {
  useCronStore.setState((state) => ({
    jobs: state.jobs.map((item) => (item.id === job.id ? job : item)),
  }));
}

export const CronWriteScopePanel: React.FC<{ job: CronJobDefinition }> = ({ job }) => {
  const cc = useI18n().t.cronCenter;
  const [isBusy, setIsBusy] = useState(false);
  // 授权点击解析不出文件夹时切到提示态（面板渲染时解析不出也会走到同一提示）。
  const [noFolderHint, setNoFolderHint] = useState(false);

  const grantedRoot = writeGrantRootFromMetadata(job.metadata);
  // 订阅会话列表（而非 getState 快照）：面板先挂载、会话列表后补页时候选文件夹能跟上。
  const sessions = useSessionStore((state) => state.sessions);
  const candidate = useMemo(() => {
    const sourceSessionId = cronSourceSessionIdFromDefinition(job);
    const sourceSession = sourceSessionId
      ? sessions.find((session) => session.id === sourceSessionId)
      : undefined;
    return cronWriteScopeFolder(job, sourceSession?.workingDirectory);
  }, [job, sessions]);

  const handleGrant = async () => {
    setIsBusy(true);
    try {
      const updated = await cronClient.grantWriteScope(job.id);
      if (updated) applyJobToStore(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(CRON_WRITE_SCOPE_NO_FOLDER)) setNoFolderHint(true);
      else console.warn('[CronWriteScopePanel] grant failed', error);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRevoke = async () => {
    setIsBusy(true);
    try {
      const updated = await cronClient.revokeWriteScope(job.id);
      if (updated) applyJobToStore(updated);
    } catch (error) {
      console.warn('[CronWriteScopePanel] revoke failed', error);
    } finally {
      setIsBusy(false);
    }
  };

  const canGrant = Boolean(candidate) && !noFolderHint;

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3"
      data-testid="cron-write-scope-panel"
    >
      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="shrink-0 text-xs text-zinc-500">{cc.writeScope.label}</span>
      {grantedRoot ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" data-testid="cron-write-scope-granted">
            {cc.writeScope.granted.replace('{folder}', grantedRoot)}
          </span>
          <Button variant="ghost" size="sm" onClick={handleRevoke} loading={isBusy} data-testid="cron-write-scope-revoke">
            {cc.writeScope.revoke}
          </Button>
        </>
      ) : canGrant ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-400" data-testid="cron-write-scope-denied">
            {cc.writeScope.notAllowed}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGrant}
            loading={isBusy}
            data-testid="cron-write-scope-allow"
            title={candidate}
          >
            {cc.writeScope.allow.replace('{folder}', candidate ?? '')}
          </Button>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-sm text-zinc-500" data-testid="cron-write-scope-no-folder">
          {cc.writeScope.noFolderHint}
        </span>
      )}
    </div>
  );
};
