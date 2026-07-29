// ============================================================================
// useVoiceLiveAvailability —— 实时通话入口可见性的两个前提（方案 §9.3）
//   1) 设置 → 语音「实时语音」总开关打开；
//   2) Realtime Provider 已配置（host 真相：secureStorage 或 env 的 key）。
// 总开关关掉 = 用户明确不要，入口不渲染；只缺 key（1 成立 2 不成立）时入口
// 降级成可点的「去配 key」引导态（LiveVoiceButton，2026-07-30），不再消失。
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

/**
 * 跨挂载记住上一次的结果。
 *
 * 这两个值要等 IPC + fetch 才知道，而输入框右侧主按钮的归属依赖它们
 * （空输入框时让给「开通话」）。每次开新会话组件重新挂载、初值又回到「不可用」，
 * 用户就会看到按钮先是发送键、几十毫秒后跳成通话键——布局抖一下。
 * 语音可用性在一次会话里基本不变，记住上次的值，重新挂载时就没有这一跳。
 */
let lastKnown = { enabled: false, configured: false, usage: NO_USAGE };

export function useVoiceLiveAvailability(): {
  enabled: boolean;
  configured: boolean;
  usage: VoiceStatusResponse['usage'];
} {
  const [enabled, setEnabled] = useState(lastKnown.enabled);
  const [configured, setConfigured] = useState(lastKnown.configured);
  const [usage, setUsage] = useState<VoiceStatusResponse['usage']>(lastKnown.usage);

  const refresh = useCallback(() => {
    let cancelled = false;
    void ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        const next = settings.voice?.live?.enabled === true;
        lastKnown = { ...lastKnown, enabled: next };
        if (!cancelled) setEnabled(next);
      })
      .catch(() => { if (!cancelled) setEnabled(false); });
    void fetchVoiceStatus()
      .then((status) => {
        lastKnown = {
          ...lastKnown,
          configured: status?.configured === true,
          usage: status?.usage ?? NO_USAGE,
        };
        if (cancelled) return;
        setConfigured(lastKnown.configured);
        setUsage(lastKnown.usage);
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
