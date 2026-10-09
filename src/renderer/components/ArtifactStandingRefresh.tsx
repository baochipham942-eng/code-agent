// ============================================================================
// ArtifactStandingRefresh - 文件产物头部的常设刷新入口（N-ARTIFACT-STANDING-REFRESH）
// ============================================================================
// 一份文件产物挂一条常设指令 + 节奏：chip 显示节奏，失败时转为警示态（短状态常显
// 「已保留上一版」，时间与原因进 title）；点击打开设置弹窗（指令 textarea + 三个
// 节奏按钮 + 保存）。
// 保存按 getPublishInfo 的 standingRefresh.jobId 决定 createJob 还是 updateJob，
// 一个文件只挂一条常设指令。到点重写、留版本、失败回滚由 host 侧负责。
// ============================================================================

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  buildStandingRefreshJobInput,
  type StandingRefreshCadence,
  type StandingRefreshJobView,
} from '@shared/artifactStandingRefresh';
import { useI18n } from '../hooks/useI18n';
import { cronClient } from '../services/cronClient';
import { createLogger } from '../utils/logger';
import { Button } from './primitives/Button';
import { Modal, ModalFooter } from './primitives/Modal';

const logger = createLogger('ArtifactStandingRefresh');

const CADENCE_ORDER: StandingRefreshCadence[] = ['hourly', 'daily', 'weekly'];

function parseCadence(value: string | undefined): StandingRefreshCadence {
  return value === 'hourly' || value === 'weekly' ? value : 'daily';
}

function workingDirectoryOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  return index === 0 ? '/' : normalized.slice(0, index);
}

async function invokeWorkspace<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.WORKSPACE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Workspace action failed: ${action}`);
  }
  return response.data as T;
}

export interface ArtifactStandingRefreshHandle {
  open: () => void;
}

export const ArtifactStandingRefresh = forwardRef<ArtifactStandingRefreshHandle, { filePath: string }>(({ filePath }, ref) => {
  const { t, language } = useI18n();
  const pv = t.previewWorkspace.preview;
  const [standingRefresh, setStandingRefresh] = useState<StandingRefreshJobView | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [cadence, setCadence] = useState<StandingRefreshCadence>('daily');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // 常设刷新视图自带一份 getPublishInfo（与 PreviewPanel 的版本信息各取各的）：
  // 组件自治后 PreviewPanel 只需挂一行，保存成功后靠 reloadNonce 重取。
  useEffect(() => {
    let cancelled = false;
    setStandingRefresh(undefined);
    void invokeWorkspace<{ standingRefresh?: StandingRefreshJobView }>('getPublishInfo', { filePath })
      .then((info) => { if (!cancelled) setStandingRefresh(info?.standingRefresh); })
      .catch(() => { if (!cancelled) setStandingRefresh(undefined); });
    return () => { cancelled = true; };
  }, [filePath, reloadNonce]);

  const openDialog = useCallback(() => {
    setInstruction(standingRefresh?.instruction ?? '');
    setCadence(parseCadence(standingRefresh?.cadence));
    setSaveError(null);
    setDialogOpen(true);
  }, [standingRefresh]);

  useImperativeHandle(ref, () => ({ open: openDialog }), [openDialog]);

  const handleSave = async () => {
    const trimmed = instruction.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = buildStandingRefreshJobInput(
        { path: filePath, instruction: trimmed, cadence },
        workingDirectoryOf(filePath),
      );
      if (standingRefresh?.jobId) await cronClient.updateJob(standingRefresh.jobId, input);
      else await cronClient.createJob(input);
      setDialogOpen(false);
      setReloadNonce((nonce) => nonce + 1);
    } catch (err) {
      logger.error('Failed to save standing refresh', err);
      setSaveError(pv.standingRefreshSaveFailed);
    } finally {
      setSaving(false);
    }
  };

  const cadenceLabel = (option: StandingRefreshCadence) => (
    option === 'hourly' ? pv.standingRefreshCadenceHourly
      : option === 'weekly' ? pv.standingRefreshCadenceWeekly
        : pv.standingRefreshCadenceDaily
  );
  const chipLabel = standingRefresh
    ? pv.standingRefreshChip.replace('{cadence}', cadenceLabel(parseCadence(standingRefresh.cadence)))
    : pv.standingRefreshSetup;
  const failure = standingRefresh?.lastRefreshFailed;
  // 失败态 chip 只放短状态（不含时间——长标签撞上 max-w 会被截掉「已保留上一版」）；
  // 时间与原因都进 title。时间按 app 语言（zh→zh-CN / en→en-US）格式化，不用浏览器
  // 默认 locale，避免 zh 界面冒出 AM/PM。
  const failureLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const failureChipLabel = failure ? pv.standingRefreshFailedChip : undefined;
  const failureTime = failure ? new Date(failure.at).toLocaleString(failureLocale) : undefined;

  return (
    <>
      <button /* ds-allow:button: 文件头部紧凑 chip，Button primitive 的固定 padding 会撑高头部行 */
        type="button"
        onClick={openDialog}
        data-testid="artifact-standing-refresh-chip"
        aria-label={failure ? failureChipLabel : chipLabel}
        title={failure
          ? pv.standingRefreshFailedDetail
            .replace('{time}', failureTime ?? '')
            .replace('{reason}', failure.reason)
          : chipLabel}
        className={`inline-flex ${failure ? '' : 'max-w-56'} items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition-colors ${
          failure
            ? 'border-badge-warning/40 bg-badge-warning/10 text-badge-warning'
            : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
        }`}
      >
        {failure
          ? <AlertTriangle className="h-3 w-3 shrink-0" />
          : <CalendarClock className="h-3 w-3 shrink-0" />}
        <span className={failure ? undefined : 'truncate'}>{failure ? failureChipLabel : chipLabel}</span>
      </button>

      <Modal
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={pv.standingRefreshDialogTitle}
        size="md"
        footer={(
          <ModalFooter
            onCancel={() => setDialogOpen(false)}
            onConfirm={() => { void handleSave(); }}
            confirmText={pv.standingRefreshSave}
            confirmDisabled={saving || !instruction.trim()}
          />
        )}
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="standing-refresh-instruction" className="mb-1 block text-xs text-zinc-400">
              {pv.standingRefreshInstructionLabel}
            </label>
            <textarea
              id="standing-refresh-instruction"
              data-modal-autofocus={true}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              rows={4}
              placeholder={pv.standingRefreshInstructionPlaceholder}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-badge-info focus:outline-none"
            />
          </div>
          <div>
            <span className="mb-1 block text-xs text-zinc-400">{pv.standingRefreshCadenceLabel}</span>
            <div className="flex gap-2" role="group" aria-label={pv.standingRefreshCadenceLabel}>
              {CADENCE_ORDER.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === cadence ? 'primary' : 'secondary'}
                  aria-pressed={option === cadence}
                  onClick={() => setCadence(option)}
                >
                  {cadenceLabel(option)}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-xs text-zinc-500">{pv.standingRefreshTargetHint}</p>
          {saveError && (
            <p className="text-xs text-badge-danger" data-testid="standing-refresh-save-error">{saveError}</p>
          )}
        </div>
      </Modal>
    </>
  );
});
