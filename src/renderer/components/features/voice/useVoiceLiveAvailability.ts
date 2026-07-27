// ============================================================================
// useVoiceLiveAvailability —— 实时通话入口可见性的两个前提（方案 §9.3）
//   1) 设置 → 语音「实时通话」总开关打开；
//   2) Realtime Provider 已配置（host 真相：secureStorage 或 env 的 key）。
// 两者缺一，LiveVoiceButton 不渲染；设置页负责解释「为什么看不到」。
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { VOICE_LIVE_SETTINGS_UPDATED_EVENT, type VoiceStatusResponse } from '@shared/contract/voice';
import ipcService from '../../../services/ipcService';

async function fetchVoiceStatus(): Promise<VoiceStatusResponse | null> {
  try {
    const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
    const query = typeof token === 'string' ? `?token=${encodeURIComponent(token)}` : '';
    const res = await fetch(`/api/voice/status${query}`);
    if (!res.ok) return null;
    return (await res.json()) as VoiceStatusResponse;
  } catch {
    return null;
  }
}

const NO_USAGE: VoiceStatusResponse['usage'] = { monthSeconds: 0, monthCalls: 0 };

export function useVoiceLiveAvailability(): {
  enabled: boolean;
  configured: boolean;
  usage: VoiceStatusResponse['usage'];
} {
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [usage, setUsage] = useState<VoiceStatusResponse['usage']>(NO_USAGE);

  const refresh = useCallback(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => { if (!cancelled) setEnabled(settings.voice?.live?.enabled === true); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    void fetchVoiceStatus()
      .then((status) => {
        if (cancelled) return;
        setConfigured(status?.configured === true);
        setUsage(status?.usage ?? NO_USAGE);
      })
      .catch(() => { if (!cancelled) { setConfigured(false); setUsage(NO_USAGE); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => refresh(), [refresh]);

  // 设置页保存后立即刷新，不用等下次挂载
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(VOICE_LIVE_SETTINGS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(VOICE_LIVE_SETTINGS_UPDATED_EVENT, handler);
  }, [refresh]);

  return { enabled, configured, usage };
}
