// ============================================================================
// VoiceApiKeyConfig —— Provider API Key 配置块（批 X3 / P1，产品负责人 2026-07-29 拍板）
//
// key 是语音模型的配置，家在「语音模型」tab **常驻展示**（配没配都在，形态不同）；
// 缺 key 时入口按钮的引导态只是补救通道，不是配置的家。
// 默认 fallback 到 DashScope，以保持旧调用点不变；VoiceModelSettings 会按当前
// Provider 传入 service/displayName/configured，使同一块 UI 服务多 Provider。
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

/**
 * API Key 说明文案 profile。与 realtime voice provider profile 对齐：
 * DashScope 共用槽说明 / OpenAI 复用 openai 槽 / 自定义按 providerId 隔离。
 * 禁止把 DashScope「图片/口述共用」文案字符串替换后套到其他 profile。
 */
export type VoiceApiKeyCopyProfile = 'dashscope' | 'openai' | 'custom';

/** 从 secure-storage 槽名推导 copy profile；独立调用点不传 profile 时的 fallback。 */
function resolveVoiceApiKeyCopyProfile(service: string): VoiceApiKeyCopyProfile {
  if (service === 'openai') return 'openai';
  if (service === 'dashscope') return 'dashscope';
  return 'custom';
}

interface VoiceApiKeyConfigProvider {
  /** Provider 显示名，用于标题/占位文案。 */
  displayName: string;
  /** 写入 secure storage 的槽位；也是 /api/voice/status configured 真相读取的槽。 */
  service: string;
  /**
   * 说明文案 profile。VoiceModelSettings 应按当前 provider profile 显式传入；
   * 未传时由 service 推导，保持独立使用与旧测试不变。
   */
  profile?: VoiceApiKeyCopyProfile;
}

export interface VoiceApiKeyConfigProps {
  /** 未传则退化为旧 DashScope 行为，保持独立使用与旧测试不变。 */
  provider?: VoiceApiKeyConfigProvider;
  /**
   * 是否已配置 Key。传入时优先使用这个值（来自 provider 列表的当前 profile），
   * 避免复用可能滞后的全局 hook；未传时回退到 useVoiceLiveAvailability。
   */
  configured?: boolean;
  /** Key 保存/清除成功后回调；上层应刷新 provider 列表以更新 configured 状态。 */
  onKeyChanged?: () => void;
}

export const VoiceApiKeyConfig: React.FC<VoiceApiKeyConfigProps> = ({ provider, configured: configuredProp, onKeyChanged }) => {
  const { t } = useI18n();
  const text = t.voice.settings;
  // 独立使用时 fallback 到全局 hook；嵌入 VoiceModelSettings 时应由外部传入。
  const { configured: configuredFromHook } = useVoiceLiveAvailability();
  const configured = configuredProp ?? configuredFromHook;

  const displayName = provider?.displayName ?? 'DashScope';
  const service = provider?.service ?? 'dashscope';
  const copyProfile = provider?.profile ?? resolveVoiceApiKeyCopyProfile(service);

  // 未配恒展开输入框；已配收起成打码值 + 「更换」。maskedKey 只记本次会话里
  // 刚保存的打码值——host 不回传打码 key（raw key 不出主进程），
  // 重新进页时已配态显示「已配置」文案兜底。
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [pendingKeyClear, setPendingKeyClear] = useState(false);

  /**
   * 保存当前 Provider API Key。写路径是 setServiceApiKey：它落在
   * secureStorage 的 `apikey.<service>` 槽——与 /api/voice/status 的 configured
   * 真相读取同一条路径。不走 settings 'set' 的 providers.*.apiKey 提取：那条会跳过空串，清除不了。
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
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service, apiKey: draft });
      setMaskedKey(maskApiKey(draft));
      setKeyDraft('');
      setKeyEditorOpen(false);
      // 广播后 useVoiceLiveAvailability 立刻重查 /api/voice/status，
      // configured 翻 true，入口按钮就地复活，不用重启
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
      onKeyChanged?.();
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
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', { service, apiKey: '' });
      setMaskedKey(null);
      setKeyDraft('');
      setKeyEditorOpen(false);
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
      onKeyChanged?.();
      toast.success(text.apiKeyCleared);
    } catch (error) {
      toast.error(`${text.apiKeySaveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    }
  };

  const title = text.apiKeyTitle.replace('DashScope', displayName);
  // 说明按 profile 选词条，禁止 .replace 把 DashScope 共用说明套到 OpenAI / 自定义
  const description = copyProfile === 'openai'
    ? text.apiKeyDescriptionOpenAI
    : copyProfile === 'custom'
      ? text.apiKeyDescriptionCustom
      : text.apiKeyDescription;
  const placeholder = text.apiKeyPlaceholder.replace('DashScope', displayName);
  const clearTitle = text.apiKeyClearTitle.replace('DashScope', displayName);
  const clearMessage = text.apiKeyClearMessage.replace('DashScope', displayName);

  return (
    <div data-testid="voice-api-key-config">
      <h3 className="mb-1 text-sm font-medium text-zinc-200">{title}</h3>
      <p className="mb-3 text-xs text-zinc-500" data-testid="voice-api-key-description">{description}</p>
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
            placeholder={placeholder}
            className="h-7 w-56 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-badge-info/60"
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
        title={clearTitle}
        message={clearMessage}
        variant="danger"
        confirmText={text.apiKeyClearConfirm}
        cancelText={t.common.cancel}
        onConfirm={() => void handleConfirmClearKey()}
        onCancel={() => setPendingKeyClear(false)}
      />
    </div>
  );
};
