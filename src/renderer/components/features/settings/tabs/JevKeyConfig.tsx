// ============================================================================
// JevKeyConfig — TypeSafe (Jev) API key row + Jev 判官状态区块 on General settings.
// Key row writes the service slot `typesafe` through setServiceApiKey (secure storage);
// display is masked; an empty save on a configured key clears only after confirm.
// 判官区块（N-JEV-DEFAULT-ON-CONSENT）：jevStatus 五态状态行 + 降级计数 + 总开关
// （setJevSettings）+「发什么给谁」披露 + 仅待同意态出现的 Allow 按钮。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ServiceApiKey } from '@shared/contract/configService';
import type { AppSettings, JevStatus } from '@shared/contract';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Toggle } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { toast } from '../../../../hooks/useToast';

const TYPESAFE_SERVICE: ServiceApiKey = 'typesafe';

const maskApiKey = (key: string) => (key.length > 8 ? `${key.substring(0, 8)}...` : key);


export const JevKeyConfig: React.FC = () => {
  const { t } = useI18n();
  const text = t.settings.general.jevKey;
  const judgeText = text.judge;
  const [configured, setConfigured] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [pendingKeyClear, setPendingKeyClear] = useState(false);
  const [jevStatus, setJevStatus] = useState<JevStatus | null>(null);
  const [jevEnabled, setJevEnabled] = useState(true);
  const [jevSaving, setJevSaving] = useState(false);

  const loadJudgeState = useCallback(async () => {
    // 状态行读失败时保持缺省（none / 开），不阻塞设置页；开关写入失败会走 toast。
    try {
      setJevStatus(await ipcService.invokeDomain<JevStatus>(IPC_DOMAINS.DIAGNOSTICS, 'jevStatus'));
    } catch {
      // keep previous state
    }
    try {
      const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
      setJevEnabled(settings?.jev?.enabled !== false);
    } catch {
      // keep default-on
    }
  }, []);

  useEffect(() => {
    void loadJudgeState();
  }, [loadJudgeState]);

  const handleJudgeSave = async (updates: { enabled?: boolean; openRouterConsent?: boolean }, optimistic: boolean) => {
    if (optimistic) setJevEnabled(!jevEnabled);
    setJevSaving(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setJevSettings', updates);
      if (updates.openRouterConsent === true) toast.success(judgeText.allowedToast);
    } catch (error) {
      if (optimistic) setJevEnabled(jevEnabled);
      toast.error(`${judgeText.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setJevSaving(false);
      void loadJudgeState();
    }
  };

  const keySource = jevEnabled ? (jevStatus?.keySource ?? 'none') : 'disabled_by_user';
  // jevStatus 形状异常（旧 host / 查询失败）不得拖垮设置页：按 0 处理。
  const degradedTotal = Object.values(jevStatus?.features ?? {})
    .reduce((sum, feature) => sum + (feature?.degradedCount ?? 0), 0);
  const disclosureProvider = keySource === 'official'
    ? judgeText.disclosureOfficial
    : judgeText.disclosureOpenrouter;

  const handleSaveKey = async () => {
    const draft = keyDraft.trim();
    if (!draft) {
      if (configured) setPendingKeyClear(true);
      return;
    }
    setKeySaving(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', {
        service: TYPESAFE_SERVICE,
        apiKey: draft,
      });
      setMaskedKey(maskApiKey(draft));
      setConfigured(true);
      setKeyDraft('');
      setKeyEditorOpen(false);
      toast.success(text.saved);
    } catch (error) {
      toast.error(`${text.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setKeySaving(false);
    }
  };

  const handleConfirmClearKey = async () => {
    setPendingKeyClear(false);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', {
        service: TYPESAFE_SERVICE,
        apiKey: '',
      });
      setMaskedKey(null);
      setConfigured(false);
      setKeyDraft('');
      setKeyEditorOpen(false);
      toast.success(text.cleared);
    } catch (error) {
      toast.error(`${text.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    }
  };

  return (
    <div data-testid="jev-api-key-config">
      <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.title}</h3>
      <p className="mb-3 text-xs text-zinc-500" data-testid="jev-api-key-description">{text.description}</p>
      {configured && !keyEditorOpen ? (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
          <span className="font-mono" data-testid="jev-key-masked">{maskedKey ?? text.configured}</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="jev-key-change"
            onClick={() => setKeyEditorOpen(true)}
          >
            {text.change}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            data-testid="jev-key-input"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={text.placeholder}
            className="h-7 w-56 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-badge-info/60"
          />
          <Button
            variant="primary"
            size="sm"
            data-testid="jev-key-save"
            onClick={() => void handleSaveKey()}
            disabled={keySaving || (!keyDraft.trim() && !configured)}
          >
            {keySaving ? text.saving : text.save}
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingKeyClear}
        title={text.clearTitle}
        message={text.clearMessage}
        variant="danger"
        confirmText={text.clearConfirm}
        cancelText={t.common.cancel}
        onConfirm={() => void handleConfirmClearKey()}
        onCancel={() => setPendingKeyClear(false)}
      />

      {/* Jev 判官状态与开关（N-JEV-DEFAULT-ON-CONSENT ②④）：状态行 + 降级计数 + 总开关
          + 发送内容披露 + 仅待同意态出现的 Allow 按钮。 */}
      <div className="mt-4 border-t border-zinc-800 pt-4" data-testid="jev-judge-section">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium text-zinc-200">
              <ShieldCheck className="h-3.5 w-3.5 text-zinc-500" />
              {judgeText.title}
            </h3>
            <p className="text-xs text-zinc-400" data-testid="jev-judge-status">
              {judgeText.status[keySource]}
            </p>
            {degradedTotal > 0 && (
              <p className="mt-0.5 text-xs text-zinc-500" data-testid="jev-degraded-count">
                {judgeText.degradedPrefix}{degradedTotal}{judgeText.degradedSuffix}
              </p>
            )}
          </div>
          <Toggle
            size="sm"
            checked={jevEnabled}
            disabled={jevSaving}
            onChange={() => void handleJudgeSave({ enabled: !jevEnabled }, true)}
            aria-label={judgeText.switchLabel}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500" data-testid="jev-disclosure">
          {judgeText.disclosurePrefix}
          <span className="text-zinc-400">{disclosureProvider}</span>
          {judgeText.disclosureSuffix}
        </p>
        {keySource === 'openrouter_pending_consent' && (
          <div className="mt-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="jev-consent-allow"
              disabled={jevSaving}
              onClick={() => void handleJudgeSave({ openRouterConsent: true }, false)}
            >
              {judgeText.allowButton}
            </Button>
          </div>
        )}
        {!jevEnabled && (
          <p className="mt-2 text-xs text-zinc-500" data-testid="jev-off-hint">{judgeText.offHint}</p>
        )}
      </div>
    </div>
  );
};
