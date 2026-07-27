// ============================================================================
// 设置页「打断方式 / 灵敏度」→ voice.turnDetection 的推导（B5）
//
// 运行时真源只有 turnDetection（host 建连时直读）；live.interrupt /
// live.vadSensitivity 是 UI 侧三态，保存时在这里折成 turnDetection
// 一起写回，两侧永不分叉。纯函数，单测钉住映射。
// ============================================================================

import type { VoiceTurnDetectionConfig } from '@shared/contract/voice';
import type { VoiceLiveSettings } from '@shared/contract/settings';
import { VOICE_TURN_DETECTION_DEFAULT } from '@shared/constants/voice';

type InterruptMode = NonNullable<VoiceLiveSettings['interrupt']>;
type VadSensitivity = NonNullable<VoiceLiveSettings['vadSensitivity']>;

/** 灵敏度档位 → server_vad threshold（越高越不灵敏，环境吵就往低调）。 */
const SENSITIVITY_THRESHOLD: Record<VadSensitivity, number> = {
  high: 0.3,
  medium: 0.5,
  low: 0.7,
};

export function deriveTurnDetection(
  interrupt: InterruptMode,
  sensitivity: VadSensitivity,
): VoiceTurnDetectionConfig {
  if (interrupt !== 'server_vad') return null; // 点按说话：手动 commit 模式
  const defaults = VOICE_TURN_DETECTION_DEFAULT;
  return {
    type: 'server_vad',
    threshold: SENSITIVITY_THRESHOLD[sensitivity],
    prefixPaddingMs: defaults?.type === 'server_vad' ? defaults.prefixPaddingMs : 300,
    silenceDurationMs: defaults?.type === 'server_vad' ? defaults.silenceDurationMs : 500,
  };
}

/**
 * 归一化历史值。`push_to_talk`（按住说话）2026-07-27 删档——它相对「点按说话」
 * 只多一条「松手必关麦」，代价是整通电话手被按在按钮上，桌面端不值。
 *
 * **迁到 server_vad 而不是 manual**（产品负责人 2026-07-27 拍板，真机踩过）：
 * 「都是手动闸麦、迁到 manual 保留原意」听起来对，实际上大多数人当初选 PTT
 * 只是随手试了一下，升级后莫名其妙要反复点按钮才能说话。回默认档（全双工）
 * 是「张嘴就说」的正常体验；真需要闸麦的人自己去设置里选点按说话。
 */
export function normalizeInterruptMode(raw: string | undefined): InterruptMode {
  return raw === 'manual' ? 'manual' : 'server_vad';
}

/** 从已有设置反推 UI 两态（老配置没有 live.* 时按 turnDetection 形状推）。 */
export function deriveInterruptMode(settings: { turnDetection?: VoiceTurnDetectionConfig; live?: VoiceLiveSettings } | undefined): InterruptMode {
  if (settings?.live?.interrupt) return normalizeInterruptMode(settings.live.interrupt);
  if (settings?.turnDetection === null) return 'manual';  // 老配置没有 live.* 时，null 断句 = 当初选的就是手动档
  return 'server_vad';
}

export function deriveVadSensitivity(settings: { turnDetection?: VoiceTurnDetectionConfig; live?: VoiceLiveSettings } | undefined): VadSensitivity {
  if (settings?.live?.vadSensitivity) return settings.live.vadSensitivity;
  const threshold = settings?.turnDetection?.type === 'server_vad' ? settings.turnDetection.threshold : undefined;
  if (threshold === undefined) return 'medium';
  if (threshold <= 0.4) return 'high';
  if (threshold >= 0.6) return 'low';
  return 'medium';
}
