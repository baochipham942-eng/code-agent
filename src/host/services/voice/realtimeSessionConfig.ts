// ============================================================================
// Realtime session 配置构造（从 realtimeTransport 拆出，god-file 债务门：effective>1000）
// turn-detection 读取/旧默认升级 + 上游 session.update 形状（两协议族分叉）。
// ============================================================================

import {
  VOICE_STALE_PREFIX_DEFAULTS_MS,
  VOICE_STALE_SILENCE_DEFAULTS_MS,
  VOICE_TURN_DETECTION_DEFAULT,
} from '../../../shared/constants/voice';
import type { RealtimeVoiceProviderProfile } from '../../../shared/constants/realtimeVoiceProviders';
import type { VoiceTurnDetectionConfig } from '../../../shared/contract/voice';
import { getConfigService } from '../core/configService';

export type UpstreamTurnDetection =
  | {
      type: 'server_vad';
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
      create_response: false;
      interrupt_response: false;
    }
  | {
      type: 'semantic_vad';
      eagerness?: 'low' | 'medium' | 'high' | 'auto';
      create_response: false;
      interrupt_response: false;
    }
  | null;

export function resolveTurnDetectionConfig(): VoiceTurnDetectionConfig {
  try {
    const voice = getConfigService().getSettings().voice;
    const configured = voice?.turnDetection;
    // `turnDetection: null` = 手动 commit 档。但删掉「按住说话」之后，老配置里会出现
    // `turnDetection: null` + `live.interrupt: 'push_to_talk'` 的组合——UI 侧把它归一到
    // 全双工了，运行时若还按 null 走，就是「UI 说全双工、上游永远等不到 commit」的
    // 分叉：用户说了没反应，连补救的点按按钮都不显示（2026-07-27 真机差点踩到）。
    // 只有**显式**留在点按档时才认这个 null。
    if (configured === null && voice?.live?.interrupt !== 'manual') return VOICE_TURN_DETECTION_DEFAULT;
    if (configured === undefined) return VOICE_TURN_DETECTION_DEFAULT;
    return upgradeStaleVadDefaults(configured);
  } catch {
    return VOICE_TURN_DETECTION_DEFAULT;
  }
}

/**
 * 存量配置里的旧默认值升级（批 X2，批 X5 补上 800）。prefix/silence 从来不是 UI 可设项
 * ——落盘里等于历代默认值之一，就只可能是「当年默认值随保存写死的拷贝」，不是用户选择。
 * 改默认值对存量零生效是踩过的坑（echoCancellation 先例），所以在读取口把旧默认识别为
 * 过期：逐字段命中历代默认表 → 升到新默认；手改过的其他值（含 threshold）原样保留。
 *
 * 历代默认表放常量文件而不是写在这里：改默认值的人改的是那个文件，旧值必须在他眼前。
 */
function upgradeStaleVadDefaults(configured: VoiceTurnDetectionConfig): VoiceTurnDetectionConfig {
  if (configured?.type !== 'server_vad') return configured;
  const defaults = VOICE_TURN_DETECTION_DEFAULT;
  if (defaults?.type !== 'server_vad') return configured;
  const isStale = (value: number | undefined, stale: readonly number[]): boolean =>
    value !== undefined && stale.includes(value);
  return {
    ...configured,
    ...(isStale(configured.prefixPaddingMs, VOICE_STALE_PREFIX_DEFAULTS_MS)
      ? { prefixPaddingMs: defaults.prefixPaddingMs }
      : {}),
    ...(isStale(configured.silenceDurationMs, VOICE_STALE_SILENCE_DEFAULTS_MS)
      ? { silenceDurationMs: defaults.silenceDurationMs }
      : {}),
  };
}


export function toUpstreamTurnDetection(config: VoiceTurnDetectionConfig): UpstreamTurnDetection {
  if (config === null) return null;
  if (config.type === 'semantic_vad') {
    return {
      type: 'semantic_vad',
      create_response: false,
      interrupt_response: false,
      ...(config.eagerness ? { eagerness: config.eagerness } : {}),
    };
  }
  return {
    type: 'server_vad',
    create_response: false,
    interrupt_response: false,
    ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
    ...(config.prefixPaddingMs !== undefined ? { prefix_padding_ms: config.prefixPaddingMs } : {}),
    ...(config.silenceDurationMs !== undefined ? { silence_duration_ms: config.silenceDurationMs } : {}),
  };
}

export function buildSessionUpdate(
  profile: RealtimeVoiceProviderProfile,
  input: {
    model: string;
    voice: string;
    instructions?: string;
    tools: readonly unknown[];
    turnDetection: UpstreamTurnDetection;
  },
): Record<string, unknown> {
  if (profile.sessionShape === 'openai-realtime') {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: input.model,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: profile.inputSampleRate },
            transcription: profile.transcriptionModel ? { model: profile.transcriptionModel } : undefined,
            turn_detection: input.turnDetection,
          },
          output: {
            format: { type: 'audio/pcm' },
            voice: input.voice,
          },
        },
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.tools.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      voice: input.voice,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      ...(profile.transcriptionModel
        ? { input_audio_transcription: { model: profile.transcriptionModel } }
        : {}),
      turn_detection: input.turnDetection,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.tools.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
    },
  };
}
