// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const openSettingsTab = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({ openSettingsTab }),
  },
}));

import { VoiceBudgetAlertNotice } from '../../../src/renderer/components/VoiceBudgetAlertNotice';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';

describe('VoiceBudgetAlertNotice', () => {
  beforeEach(() => {
    openSettingsTab.mockReset();
    useToastStore.setState({ toasts: [] });
    useVoiceCallStore.getState().reset();
  });

  afterEach(cleanup);

  it('告警档 warning toast，到上限 error toast 并带去设置', () => {
    render(<VoiceBudgetAlertNotice />);

    act(() => {
      useVoiceCallStore.getState().budgetApplied({
        level: 'warning',
        usageRatio: 0.85,
        minutesUsed: 4.25,
        minutesLimit: 5,
        costAmount: null,
        costCurrency: null,
        costLimit: null,
      });
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].type).toBe('warning');
    expect(useToastStore.getState().toasts[0].message).toBe(zh.voice.messageByCode.VOICE_BUDGET_WARNING);

    act(() => {
      useVoiceCallStore.getState().budgetApplied({
        level: 'blocked',
        usageRatio: 1,
        minutesUsed: 5,
        minutesLimit: 5,
        costAmount: null,
        costCurrency: null,
        costLimit: null,
      });
    });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1].type).toBe('error');
    expect(toasts[1].message).toBe(zh.voice.messageByCode.VOICE_BUDGET_EXCEEDED);
    expect(toasts[1].action?.label).toBe(zh.voice.live.settingsAction);
    toasts[1].action?.onClick();
    expect(openSettingsTab).toHaveBeenCalledWith('voiceLive');
  });

  it('同一档位重复快照不重复弹 toast', () => {
    render(<VoiceBudgetAlertNotice />);
    const snapshot = {
      level: 'warning' as const,
      usageRatio: 0.9,
      minutesUsed: 4.5,
      minutesLimit: 5,
      costAmount: null,
      costCurrency: null,
      costLimit: null,
    };
    act(() => {
      useVoiceCallStore.getState().budgetApplied(snapshot);
      useVoiceCallStore.getState().budgetApplied({ ...snapshot, usageRatio: 0.91 });
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
