// ============================================================================
// VoiceApiKeyConfig —— DashScope API Key 配置块（批 X3，产品负责人 2026-07-29 拍板）
//
// key 是语音模型的配置，家在「语音模型」tab **常驻展示**（配没配都在，形态不同）；
// 缺 key 时入口按钮的引导态只是补救通道，不是配置的家。
// 从 VoiceLiveSettingsSection 整体搬出（#810 首落时放错了 tab——那边顶注明写
// 「模型归模型的家，本 tab 只留使用偏好」）。逻辑原样：#796 搜索源同构。
// ============================================================================

import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '@shared/contract/voice';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { Button } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { toast } from '../../../../hooks/useToast';

/** 与 settings.ipc.ts handleGetAllServiceKeys 同一套打码规则：前 8 位 + `...`。 */
const maskApiKey = (key: string) => (key.length > 8 ? `${key.substring(0, 8)}...` : key);

export const VoiceApiKeyConfig: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  // configured 是 host /api/voice/status 的真相：配 key 成功广播
  // VOICE_LIVE_SETTINGS_UPDATED_EVENT 后 hook 自刷新，本组跟着翻转。
  const { configured } = useVoiceLiveAvailability();

  // 未配恒展开输入框；已配收起成打码值 + 「更换」。maskedKey 只记本次会话里
  // 刚保存的打码值——host 不回传打码 key（raw key 不出主进程），
  // 重新进页时已配态显示「已配置」文案兜底。
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [pendingKeyClear, setPendingKeyClear] = useState(false);

  /**
   * 保存 DashScope API Key。写路径是 setServiceApiKey（#796 先例）：它落在
   * secureStorage 的 `apikey.dashscope` 槽——正是 configService.getApiKey('dashscope')
   * （/api/voice/status 的 configured 真相）首读的位置，写/清除同一条路径。
   * 不走 settings 'set' 的 providers.*.apiKey 提取：那条会跳过空串，清除不了。
   * 空串 = 清除，先过 ConfirmDialog。
   */
  const handleSaveKey = async () => {
    const draft = keyDraft.trim();
    if (!draft) {
      if (configured) setPendingKeyClear(true);
      return;
    }
    setKeySaving(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service: 'dashscope', apiKey: draft });
      setMaskedKey(maskApiKey(draft));
      setKeyDraft('');
      setKeyEditorOpen(false);
      // 广播后 useVoiceLiveAvailability 立刻重查 /api/voice/status，
      // configured 翻 true，入口按钮就地复活，不用重启
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
      toast.success(text.apiKeySaved);
    } catch (error) {
      toast.error(`${text.apiKeySaveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setKeySaving(false);
    }
  };

  const handleConfirmClearKey = async () => {
    setPendingKeyClear(false);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service: 'dashscope', apiKey: '' });
      setMaskedKey(null);
      setKeyDraft('');
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
      toast.success(text.apiKeyCleared);
    } catch (error) {
      toast.error(`${text.apiKeySaveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    }
  };

  return (
    <div data-testid="voice-api-key-config">
      <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.apiKeyTitle}</h3>
      <p className="mb-3 text-xs text-zinc-500">{text.apiKeyDescription}</p>
      {configured && !keyEditorOpen ? (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
          <span className="font-mono" data-testid="voice-live-key-masked">{maskedKey ?? text.providerConfigured}</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="voice-live-key-change"
            onClick={() => setKeyEditorOpen(true)}
          >
            {text.apiKeyChange}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            data-testid="voice-live-key-input"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={text.apiKeyPlaceholder}
            className="h-7 w-56 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-500/60"
          />
          <Button
            variant="primary"
            size="sm"
            data-testid="voice-live-key-save"
            onClick={() => void handleSaveKey()}
            disabled={keySaving || (!keyDraft.trim() && !configured)}
          >
            {keySaving ? text.apiKeySaving : text.apiKeySave}
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingKeyClear}
        title={text.apiKeyClearTitle}
        message={text.apiKeyClearMessage}
        variant="danger"
        confirmText={text.apiKeyClearConfirm}
        cancelText={t.common.cancel}
        onConfirm={() => void handleConfirmClearKey()}
        onCancel={() => setPendingKeyClear(false)}
      />
    </div>
  );
};

export default VoiceApiKeyConfig;
