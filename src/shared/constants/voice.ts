// ============================================================================
// 实时语音（Realtime Voice）常量
// Phase 0 spike：仅 Qwen-Omni Realtime（DashScope，WebSocket 形态）。
// ============================================================================

/**
 * DashScope Qwen-Omni Realtime WebSocket 接入点。
 *
 * 2026-07-26 实测：文档写的是 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`，
 * 但该形态需要 workspace 前缀；下面这个无 workspace 前缀的地址用 Bearer key 直接握手成功。
 * 以实测为准。
 */
export const QWEN_OMNI_REALTIME_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

/** 默认对话模型。plus/flash 见 https://help.aliyun.com/zh/model-studio/realtime */
export const QWEN_OMNI_REALTIME_MODEL = 'qwen3-omni-flash-realtime';

/** 用户语音转写模型（input_audio_transcription），出字幕用。 */
export const QWEN_OMNI_REALTIME_TRANSCRIPTION_MODEL = 'gummy-realtime-v1';

/** 默认音色。 */
export const QWEN_OMNI_REALTIME_VOICE = 'Chelsie';

/** 上行麦克风采样率（Hz），厂商要求 16k 单声道 PCM16。 */
export const VOICE_UPSTREAM_SAMPLE_RATE = 16_000;

/** 下行助手音频采样率（Hz），厂商固定 24k 单声道 PCM16。 */
export const VOICE_DOWNSTREAM_SAMPLE_RATE = 24_000;

/** 上游 WS 握手超时（ms）。 */
export const VOICE_UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** 通话最长时长（ms），到点强制挂断，兜住忘记挂断导致的持续计费。 */
export const VOICE_SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

/** Renderer→Host 媒体面 WS 路径。 */
export const VOICE_STREAM_WS_PATH = '/api/voice/stream';

/** dev-only 入口开关的 localStorage 键。Phase 1 换成正式设置项后删除。 */
export const VOICE_DEV_FLAG_KEY = 'code-agent:voice-spike';
