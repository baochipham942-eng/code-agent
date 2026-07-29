// ============================================================================
// VoiceLiveSettingsSection —— 设置 → 语音「实时语音」组（B5，§7.6 IA）
//
// 总开关 / 语言 / 打断方式三态 + 灵敏度 / 回声消除 / 通话用量 / 隐私说明（§8.3）。
// T1（2026-07-28）：通话模型·Provider 与音色搬去「模型与能力」组的「语音模型」tab
// （VoiceModelSettings），本 tab 只留使用偏好；persist 透传本 tab 不拥有的 live 键。
// 独立「实时语音」tab（VoiceLiveSettings 薄壳）；口述输入在「语音转文字」tab。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Check, KeyRound, ShieldCheck } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import { PROVIDER_MODELS, PROVIDER_MODELS_MAP } from '@shared/constants/models';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { Toggle } from '../../../primitives/Toggle';
import { Button } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { useVoiceLiveAvailability } from '../../voice/useVoiceLiveAvailability';
import { deriveInterruptMode, deriveTurnDetection, deriveVadSensitivity } from '../../voice/voiceSettingsDerivation';

const logger = createLogger('VoiceLiveSettings');

type InterruptMode = NonNullable<VoiceLiveSettings['interrupt']>;
type VadSensitivity = NonNullable<VoiceLiveSettings['vadSensitivity']>;
type EchoCancellationMode = NonNullable<VoiceLiveSettings['echoCancellation']>;

const INTERRUPT_OPTIONS: InterruptMode[] = ['server_vad', 'manual'];
const SENSITIVITY_OPTIONS: VadSensitivity[] = ['low', 'medium', 'high'];

export const VoiceLiveSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const text = t.voice.settings;
  // configured 是 host /api/voice/status 的真相：配 key 成功广播
  // VOICE_LIVE_SETTINGS_UPDATED_EVENT 后 hook 自刷新，本组跟着翻转。
  const { usage, configured } = useVoiceLiveAvailability();

  // Key 编辑区状态（#796 搜索源就地配 key 同构）：未配恒展开；已配收起成
  // 打码值 + 「更换」。maskedKey 只记本次会话里刚保存的打码值——host 不回传
  // 打码 key（raw key 不出主进程），重新进页时已配态显示「已配置」文案兜底。
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [pendingKeyClear, setPendingKeyClear] = useState(false);

  // baseLive 透传本 tab 不拥有的 live 键（通话模型/音色已搬「语音模型」tab），
  // persist 时原样带回，避免整对象写入把它们抹掉。
  const [baseLive, setBaseLive] = useState<VoiceLiveSettings>({});
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState<NonNullable<VoiceLiveSettings['language']>>('auto');
  const [interrupt, setInterrupt] = useState<InterruptMode>('server_vad');
  const [sensitivity, setSensitivity] = useState<VadSensitivity>('medium');
  const [executionModel, setExecutionModel] = useState<VoiceLiveSettings['executionModel']>(undefined);
  const [echoCancellation, setEchoCancellation] = useState<EchoCancellationMode>('auto');

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (cancelled) return;
        const voice = settings.voice;
        setBaseLive(voice?.live ?? {});
        setEnabled(voice?.live?.enabled === true);
        setLanguage(voice?.live?.language ?? 'auto');
        setInterrupt(deriveInterruptMode(voice));
        setSensitivity(deriveVadSensitivity(voice));
        setExecutionModel(voice?.live?.executionModel);
        setEchoCancellation(voice?.live?.echoCancellation ?? 'auto');
      })
      .catch((error) => logger.error('load voice live settings failed', error));
    return () => { cancelled = true; };
  }, []);

  const persist = async (patch: Partial<VoiceLiveSettings>) => {
    const nextLive: VoiceLiveSettings = {
      ...baseLive,
      enabled,
      language,
      interrupt,
      vadSensitivity: sensitivity,
      ...(executionModel ? { executionModel } : {}),
      echoCancellation,
      ...patch,
    };
    // executionModel 清空 = 回到「跟随会话默认引擎」（把键去掉，不是写一个空值）
    if (!nextLive.executionModel) delete nextLive.executionModel;
    // 应用到本地 state
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.language !== undefined) setLanguage(patch.language);
    if (patch.interrupt !== undefined) setInterrupt(patch.interrupt);
    if (patch.vadSensitivity !== undefined) setSensitivity(patch.vadSensitivity);
    if (patch.echoCancellation !== undefined) setEchoCancellation(patch.echoCancellation);

    const nextInterrupt = patch.interrupt ?? interrupt;
    const nextSensitivity = patch.vadSensitivity ?? sensitivity;
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        voice: {
          // 运行时真源 turnDetection 与 UI 三态一起写，两侧不分叉
          turnDetection: deriveTurnDetection(nextInterrupt, nextSensitivity),
          live: nextLive,
        },
      } as Partial<AppSettings>);
      setBaseLive(nextLive);
      window.dispatchEvent(new CustomEvent(VOICE_LIVE_SETTINGS_UPDATED_EVENT));
    } catch (error) {
      logger.error('save voice live settings failed', error);
    }
  };

  /** 传 undefined = 回到「跟随会话默认引擎」（把键去掉，不是写一个空值）。 */
  const persistExecutionModel = async (next: VoiceLiveSettings['executionModel']) => {
    setExecutionModel(next);
    await persist({ executionModel: next });
  };

  /** 与 settings.ipc.ts handleGetAllServiceKeys 同一套打码规则：前 8 位 + `...`。 */
  const maskApiKey = (key: string) => (key.length > 8 ? `${key.substring(0, 8)}...` : key);

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

  const interruptText: Record<InterruptMode, { label: string; desc: string }> = {
    server_vad: { label: text.interruptServerVad, desc: text.interruptServerVadDesc },
    manual: { label: text.interruptManual, desc: text.interruptManualDesc },
  };
  const sensitivityText: Record<VadSensitivity, string> = {
    low: text.sensitivityLow,
    medium: text.sensitivityMedium,
    high: text.sensitivityHigh,
  };

  return (
    <div className="space-y-6" data-testid="voice-live-settings">
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.enableTitle}</h3>
          <p className="text-xs text-zinc-500">{text.enableDescription}</p>
        </div>
        <Toggle
          size="md"
          checked={enabled}
          onChange={(next) => void persist({ enabled: next })}
          aria-label={text.enableTitle}
        />
      </div>

      {/* API Key 就地配置（#796 搜索源同构）：未配恒展开输入框；已配收起成
          打码值 + 「更换」；空串保存 = 清除（ConfirmDialog 确认） */}
      <div className="border-t border-zinc-700 pt-4">
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
      </div>

      {/* 执行引擎（§6.1 双脑）：通话模型只负责听说，真干活是另一个模型，两者分开看分开配 */}
      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.executionModelTitle}</h3>
        <p className="mb-3 text-xs text-zinc-500">{text.executionModelDescription}</p>
        <div className="grid grid-cols-2 gap-4">
          <select
            data-testid="voice-execution-provider"
            value={executionModel?.provider ?? ''}
            onChange={(event) => {
              const provider = event.target.value;
              if (!provider) return void persistExecutionModel(undefined);
              const first = PROVIDER_MODELS_MAP[provider]?.models[0]?.id;
              return void persistExecutionModel(first ? { provider, model: first } : undefined);
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            <option value="">{text.executionModelFollowSession}</option>
            {PROVIDER_MODELS.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
          <select
            data-testid="voice-execution-model"
            value={executionModel?.model ?? ''}
            disabled={!executionModel}
            onChange={(event) => {
              if (!executionModel) return;
              void persistExecutionModel({ provider: executionModel.provider, model: event.target.value });
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500 disabled:opacity-40"
          >
            {executionModel
              ? (PROVIDER_MODELS_MAP[executionModel.provider]?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))
              : <option value="">{text.executionModelFollowSession}</option>}
          </select>
        </div>
      </div>

      {/* 本月通话用量：只记账不设限（方案 §5.4，产品负责人 2026-07-27 拍板） */}
      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.usageTitle}</h3>
        <p className="text-xs text-zinc-500" data-testid="voice-usage-summary">
          {text.usageThisMonth
            .replace('{minutes}', String(Math.round(usage.monthSeconds / 60)))
            .replace('{calls}', String(usage.monthCalls))}
        </p>
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.languageLabel}</span>
          <select
            value={language}
            onChange={(event) => void persist({ language: event.target.value as NonNullable<VoiceLiveSettings['language']> })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            <option value="auto">{text.languageAuto}</option>
            <option value="zh">{text.languageZh}</option>
            <option value="en">{text.languageEn}</option>
          </select>
        </label>
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-zinc-200">{text.echoCancellationTitle}</span>
          <select
            data-testid="voice-echo-cancellation"
            value={echoCancellation}
            onChange={(event) => void persist({
              echoCancellation: event.target.value as EchoCancellationMode,
            })}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
          >
            <option value="auto">{text.echoCancellationAuto}</option>
            <option value="off">{text.echoCancellationOff}</option>
          </select>
          <p className="text-xs leading-5 text-zinc-500">
            {echoCancellation === 'auto'
              ? text.echoCancellationAutoDesc
              : text.echoCancellationOffDesc}
          </p>
        </label>
      </div>

      <div className="border-t border-zinc-700 pt-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-200">{text.interruptTitle}</h3>
        <div className="grid grid-cols-2 gap-3">
          {INTERRUPT_OPTIONS.map((option) => {
            const active = interrupt === option;
            return (
              <button
                key={option}
                type="button"
                data-testid={`voice-interrupt-${option}`}
                onClick={() => void persist({ interrupt: option })}
                className={`relative rounded-lg border p-3 text-left transition-all ${
                  active
                    ? 'border-zinc-500 bg-zinc-800/60 ring-1 ring-white/10'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className="text-sm font-medium text-zinc-300">{interruptText[option].label}</div>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{interruptText[option].desc}</p>
                {active && (
                  <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200">
                    <Check className="h-3 w-3 text-zinc-950" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {interrupt === 'server_vad' && (
          <label className="mt-4 block space-y-2">
            <span className="text-sm font-medium text-zinc-200">{text.sensitivityLabel}</span>
            <select
              data-testid="voice-vad-sensitivity"
              value={sensitivity}
              onChange={(event) => void persist({ vadSensitivity: event.target.value as VadSensitivity })}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary-500"
            >
              {SENSITIVITY_OPTIONS.map((option) => (
                <option key={option} value={option}>{sensitivityText[option]}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-zinc-700 bg-zinc-900/60 p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
        <div>
          <div className="text-sm font-medium text-zinc-200">{text.privacyTitle}</div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{text.privacyBody}</p>
        </div>
      </div>

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

export default VoiceLiveSettingsSection;
