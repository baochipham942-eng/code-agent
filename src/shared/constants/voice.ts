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

/** Dictation 使用的 Gummy 实时识别接入点与任务参数。 */
export const GUMMY_REALTIME_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
export const GUMMY_REALTIME_MODEL = 'gummy-realtime-v1';
export const GUMMY_REALTIME_SAMPLE_RATE = 16_000;
export const GUMMY_REALTIME_MAX_END_SILENCE_MS = 800;

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

/** Tauri 原生 AEC sidecar 的上行音频/电平/生命周期事件。 */
export const VOICE_AEC_OUTPUT_EVENT = 'voice-aec:output';

/** PCM 经 JSON IPC 传给 Rust 时的 base64 分块大小，避免一次展开大数组撑爆调用栈。 */
export const VOICE_AEC_BASE64_CHUNK_BYTES = 0x8000;

/** 上游 WS 握手超时（ms）。 */
export const VOICE_UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** 通话最长时长（ms），到点强制挂断，兜住忘记挂断导致的持续计费。 */
export const VOICE_SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

/**
 * 挂断后的上游排水窗（ms）：用户 ASR completed 与助手 transcript done 常在挂断后
 * ~1s 内才到，立刻关 WS 会把这通电话说过的话全部丢掉（2026-07-26 真机：12s 通话
 * 落库只剩摘要）。窗口内到达的 final 照常落库，超时后再关。
 */
export const VOICE_TEARDOWN_DRAIN_MS = 1500;

/**
 * 客户端断开后等它回来的宽限窗（批 H · 断线重连 sticky）。
 * 窗口内不挂断上游、不落通话摘要——否则每次网络抖动都会在消息流里落一张
 * 「通话结束」卡，然后重连变成第二通电话。超时才走正常 teardown。
 */
export const VOICE_RECONNECT_GRACE_MS = 15_000;

/** Renderer 侧重连退避（毫秒）。用完还没连上就如实报断线，不再假装还在通话。 */
export const VOICE_RECONNECT_BACKOFF_MS = [500, 1500, 4000] as const;

/** 焦点上报最小间隔：这是 appStore 高频订阅，别每次面板切换都推一次 session.update。 */
export const VOICE_FOCUS_REPORT_MIN_INTERVAL_MS = 1000;

/** get_current_file_summary 兜底路径最多回几个文件路径，别把通话摘要撑成一屏。 */
export const VOICE_RECENT_FILE_LIMIT = 8;

/** 语音派发任务的迭代上限：通话场景的任务应该是小活，跑飞了要有个头。 */
export const VOICE_SPAWN_TASK_MAX_ITERATIONS = 30;

/** Renderer→Host 媒体面 WS 路径。 */
export const VOICE_STREAM_WS_PATH = '/api/voice/stream';

/** Renderer→Host Dictation 流式识别 WS 路径。 */
export const DICTATION_STREAM_WS_PATH = '/api/voice/dictation';
