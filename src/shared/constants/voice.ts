// ============================================================================
// 实时语音（Realtime Voice）常量
// Phase 0 spike：仅 Qwen-Omni Realtime（DashScope，WebSocket 形态）。
// ============================================================================

import type { VoiceTurnDetectionConfig } from '../contract/voice';

/**
 * DashScope Qwen-Omni Realtime WebSocket 接入点。
 *
 * 2026-07-26 实测：文档写的是 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`，
 * 但该形态需要 workspace 前缀；下面这个无 workspace 前缀的地址用 Bearer key 直接握手成功。
 * 以实测为准。
 */
export const QWEN_OMNI_REALTIME_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

/**
 * 默认对话模型。plus/flash 见 https://help.aliyun.com/zh/model-studio/realtime
 *
 * 2026-07-26 实测：**tools 支持按模型分化**——3.5 系接受 session.tools 并真发
 * function_call；上一代 `qwen3-omni-flash-realtime` 会**静默丢弃** tools 字段
 * （session.updated 回显 tools: null，不报错、不降级提示）。窄工具是语音指挥台的
 * 前提，所以默认模型钉在 3.5 flash。换回上一代 = 通话只剩闲聊。
 */
export const QWEN_OMNI_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime';

/** 用户语音转写模型（input_audio_transcription），出字幕用。 */
export const QWEN_OMNI_REALTIME_TRANSCRIPTION_MODEL = 'gummy-realtime-v1';

/**
 * 默认音色。**音色枚举与模型强绑定**，换模型必须一起验。
 *
 * 2026-07-26 实测（qwen3.5-omni-flash-realtime）：`Tina`/`Ethan`/`Serena` 能出声，
 * 上一代默认的 `Chelsie` 与 `Cherry` 一律 400 `Voice 'X' is not supported`。
 * 更阴的是**这个错不在建连时报**——`session.update` 照收、`session.updated` 原样回显音色，
 * 直到第一次真合成才 400。所以「session.updated 回显了」不能当作音色可用的判据。
 */
export const QWEN_OMNI_REALTIME_VOICE = 'Tina';

/**
 * `qwen3.5-omni-flash-realtime` 实测可用音色白名单（2026-07-26 真机逐个合成验证）。
 * 设置页音色选择器只能从这里出选项——音色枚举与模型强绑定，换模型必须重新真跑一遍。
 */
export const QWEN_OMNI_REALTIME_VOICE_WHITELIST = ['Tina', 'Ethan', 'Serena'] as const;

/**
 * 显式写死 server_vad 默认值，是为了 ttfaPerceivedMs 能算得出静音窗。
 * 上游常见默认：threshold=0.5、prefix_padding_ms=300、silence_duration_ms=500。
 */
export const VOICE_TURN_DETECTION_DEFAULT: VoiceTurnDetectionConfig = {
  type: 'server_vad',
  threshold: 0.5,
  prefixPaddingMs: 300,
  silenceDurationMs: 500,
};

/** 上行麦克风采样率（Hz），厂商要求 16k 单声道 PCM16。 */
export const VOICE_UPSTREAM_SAMPLE_RATE = 16_000;

/** 下行助手音频采样率（Hz），厂商固定 24k 单声道 PCM16。 */
export const VOICE_DOWNSTREAM_SAMPLE_RATE = 24_000;

/** 上游 WS 握手超时（ms）。 */
export const VOICE_UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** 通话最长时长（ms），到点强制挂断，兜住忘记挂断导致的持续计费。 */
export const VOICE_SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

/** get_current_file_summary 最多回几个文件路径，别把通话摘要撑成一屏。 */
export const VOICE_RECENT_FILE_LIMIT = 8;

/** 语音派发任务的迭代上限：通话场景的任务应该是小活，跑飞了要有个头。 */
export const VOICE_SPAWN_TASK_MAX_ITERATIONS = 30;

/** Renderer→Host 媒体面 WS 路径。 */
export const VOICE_STREAM_WS_PATH = '/api/voice/stream';
