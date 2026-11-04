// ============================================================================
// CronCloudSettingsCard — 云端计划任务服务（Webhook 触发的唯一投递通道）配置卡
// 形态照搬 SearchSettings 的产物托管卡：地址进 settings，令牌只进 secureStorage
// （neo-cron-cloud），保存后打码显示 + 「更换」。保存成功后通知主进程幂等启动
// 云端事件流，免重启即可接收 hook 投递。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { invokeDomain } from '../../../../services/ipcService';
import { cronClient } from '../../../../services/cronClient';
import { useCronCloudConfig } from '../../cron/useCronCloudConfig';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';

export const CronCloudSettingsCard: React.FC = () => {
  const { t } = useI18n();
  const copy = t.cronCenter.cloudSettings;
  const config = useCronCloudConfig();
  const [baseUrl, setBaseUrl] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenEditing, setTokenEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setBaseUrl(config.baseUrl); }, [config.baseUrl]);

  const handleSave = async () => {
    const url = baseUrl.trim().replace(/\/+$/, '');
    const token = tokenDraft.trim();
    if (!url) { toast.error(copy.baseUrlRequired); return; }
    if (!token && !config.maskedToken) { toast.error(copy.tokenRequired); return; }
    setSaving(true);
    try {
      await invokeDomain(IPC_DOMAINS.SETTINGS, 'set', { settings: { cronCloud: { baseUrl: url } } });
      if (token) await invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service: 'neo-cron-cloud', apiKey: token });
      await cronClient.ensureCloudStream();
      setTokenDraft('');
      setTokenEditing(false);
      setBaseUrl(url);
      await config.reload();
      toast.success(copy.saved);
    } catch (error) {
      toast.error(`${copy.saveFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div id="cron-cloud-settings-section" tabIndex={-1} data-testid="cron-cloud-settings-section">
      <SettingsSection title={copy.title} description={copy.description}>
        <div className="space-y-4 rounded-lg border border-zinc-700 bg-zinc-900/60 p-4">
          <label className="block space-y-1.5 text-xs text-zinc-300">
            <span>{copy.baseUrlLabel}</span>
            <Input
              type="text"
              inputSize="sm"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://"
              data-testid="cron-cloud-base-url"
            />
          </label>
          <div className="space-y-1.5 text-xs text-zinc-300">
            <span>{copy.tokenLabel}</span>
            {config.maskedToken && !tokenEditing ? (
              <div className="flex items-center gap-2 text-zinc-400">
                <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
                <span className="font-mono" data-testid="cron-cloud-token-masked">{config.maskedToken}</span>
                <Button variant="ghost" size="sm" onClick={() => setTokenEditing(true)}>
                  {copy.changeToken}
                </Button>
              </div>
            ) : (
              <Input
                type="password"
                inputSize="sm"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder={copy.tokenPlaceholder}
                data-testid="cron-cloud-token-input"
              />
            )}
          </div>
          <p className="text-xs leading-5 text-zinc-500">{copy.note}</p>
          <Button variant="primary" size="sm" onClick={() => void handleSave()} loading={saving} data-testid="cron-cloud-save">
            {copy.save}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
};
