// ============================================================================
// VoiceBudgetAlertNotice - 通话预算告警 toast（headless，复用 BudgetAlertNotice 范式）
// ============================================================================
import { useEffect } from 'react';
import { toast } from '../hooks/useToast';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { useVoiceCallStore } from '../stores/voiceCallStore';
import type { VoiceBudgetLevel } from '@shared/contract/voice';

function openVoiceLiveSettings(): void {
  useAppStore.getState().openSettingsTab('voiceLive');
}

/**
 * 订阅通话预算档位。用 store.subscribe 而不是 React 渲染，是为了赶在
 * session.ended 把 store reset 之前弹出 blocked toast。
 */
export function VoiceBudgetAlertNotice(): null {
  const { t } = useI18n();
  useEffect(() => {
    let previous: VoiceBudgetLevel = 'none';
    const unsubscribe = useVoiceCallStore.subscribe((state) => {
      const level = state.budget?.level ?? 'none';
      if (level === 'warning' && previous !== 'warning' && previous !== 'blocked') {
        toast.warning(t.voice.messageByCode.VOICE_BUDGET_WARNING);
      }
      if (level === 'blocked' && previous !== 'blocked') {
        toast.error(t.voice.messageByCode.VOICE_BUDGET_EXCEEDED, {
          label: t.voice.live.settingsAction,
          onClick: openVoiceLiveSettings,
        });
      }
      previous = level;
    });
    return unsubscribe;
  }, [t]);

  return null;
}
