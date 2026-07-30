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

/** 口述词表最多保留多少个有效词条，防止 instructions 无界膨胀。 */
export const VOICE_VOCABULARY_MAX_ENTRIES = 100;

/** 单个口述词表词条的最大长度；超长词条直接丢弃。 */
export const VOICE_VOCABULARY_MAX_TERM_LENGTH = 40;

/**
 * finish-task 之后等 task-finished 的上限。上游不回这一帧时既不能让 UI 永远卡在
 * 「识别中」，也不能留着一条按秒计费的 WS——超时就当收尾成功，把已经拿到的文字留下。
 */
export const GUMMY_REALTIME_FINISH_TIMEOUT_MS = 5_000;

/**
 * task-started 之前到达的音频帧最多缓多少个。协议不允许在 task-started 前推音频，
 * 直接丢会吞掉用户的第一个字；缓冲要封顶，否则上游一直不回就把内存吃光。
 */
export const GUMMY_REALTIME_PRESTART_FRAME_LIMIT = 40;

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
 * 设置页音色选择器只能从当前模型的 voices 出选项——音色枚举与模型强绑定，换模型必须重新真跑一遍。
 * 只被本文件的 QWEN_OMNI_REALTIME_MODEL_OPTIONS 引用，不单独导出（knip 棘轮）。
 */
const QWEN_OMNI_REALTIME_VOICE_WHITELIST = ['Tina', 'Ethan', 'Serena'] as const;

/**
 * 通话模型白名单（2026-07-28 工单③）。设置页只能从这里出选项，不做自由输入。
 *
 * 每条带两个判据，来源分明：
 * - `supportsTools`：2026-07-26 真机实测——3.5 系接受 session.tools 并真发 function_call；
 *   上一代 `qwen3-omni-flash-realtime` **静默丢弃** tools（session.updated 回显 tools: null，
 *   不报错）。不支持 tools 的模型留在表里是给「只想聊天」的场景，UI 选中时必须当场说清代价。
 * - `voices`：**音色枚举与模型强绑定**——3.5 上 `Chelsie`/`Cherry` 一律 400
 *   `Voice 'X' is not supported`，且这个错不在建连时报，第一次真合成才炸；上游文档
 *   （help.aliyun.com/zh/model-studio/omni-voice-list）的音色表也按模型分节。
 *   3.5 系沿用真机逐个合成验证过的白名单；上一代来自上游文档音色表，未逐个真跑。
 *
 * 这张表只是「我们以为上游会怎样」；上游行为以 session.updated 真实回显为准——
 * qwenOmniTransport 的 tools 丢弃告警钉在回显上，不钉在这张表上。
 */
export const QWEN_OMNI_REALTIME_MODEL_OPTIONS = [
  {
    id: QWEN_OMNI_REALTIME_MODEL,
    supportsTools: true,
    voices: QWEN_OMNI_REALTIME_VOICE_WHITELIST,
  },
  {
    id: 'qwen3-omni-flash-realtime',
    supportsTools: false,
    // 上游文档该模型的默认音色是 Cherry；Tina 是 3.5 系独有，这张表里没有它。
    voices: ['Cherry', 'Ethan', 'Serena'],
  },
] as const;

type VoiceConversationModelOption = (typeof QWEN_OMNI_REALTIME_MODEL_OPTIONS)[number];

/**
 * 按 id 查白名单项；未配置 / 表外 id 一律回落默认模型。
 * 设置是用户可手改的 JSON，「表外 id 原样发给上游」等于白名单形同虚设。
 */
export function resolveConversationModelOption(id: string | undefined): VoiceConversationModelOption {
  return QWEN_OMNI_REALTIME_MODEL_OPTIONS.find((option) => option.id === id) ?? QWEN_OMNI_REALTIME_MODEL_OPTIONS[0];
}

/**
 * 显式写死 server_vad 默认值，是为了 ttfaPerceivedMs 能算得出静音窗。
 * 上游常见默认：threshold=0.5、prefix_padding_ms=300、silence_duration_ms=500。
 *
 * silence 500→800（批 X2，2026-07-29 阶梯停顿 A/B 实测）：VAD 会把语音尾音衰减段
 * 提前计入静默，感知静默 ≈ 真实停顿 + ~300ms。500 档下句中停顿 300ms 就被切成
 * 独立轮次（真人犹豫 200-400ms 是常态 → 必切碎，「第一句被切成一个字」的主因）；
 * 800 档实测容住 450ms 停顿、600ms 才断。代价是收话判定慢 300ms，已计入 ttfa 口径。
 * prefix 300→500：VAD 切分后的续段持续丢头（「叫」被吃、「内容」听成「总」），
 * 300ms 回补盖不住 onset 检测延迟。
 */
export const VOICE_TURN_DETECTION_DEFAULT: VoiceTurnDetectionConfig = {
  type: 'server_vad',
  threshold: 0.5,
  prefixPaddingMs: 500,
  silenceDurationMs: 800,
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

/** 上游 WS 心跳间隔（ms）；用于主动触发 TCP 层断链探测。 */
export const VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/** 上游完全无消息 / pong 的最长容忍时间（ms）。 */
export const VOICE_UPSTREAM_SILENCE_TIMEOUT_MS = 30_000;

/** 已提交用户轮次等待模型创建响应的窗口（ms）；首轮超时后 nudge，再超时提示用户。 */
export const VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS = 10_000;

/** 通话最长时长（ms），到点强制挂断，兜住忘记挂断导致的持续计费。 */
export const VOICE_SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

/**
 * 挂断后的上游排水窗（ms）：用户 ASR completed 与助手 transcript done 常在挂断后
 * ~1s 内才到，立刻关 WS 会把这通电话说过的话全部丢掉（2026-07-26 真机：12s 通话
 * 落库只剩摘要）。窗口内到达的 final 照常落库，超时后再关。
 */
export const VOICE_TEARDOWN_DRAIN_MS = 1500;

/**
 * 模型调 end_call 之后，等它把告别说完的兜底上限（ms）。
 * 正常路径是听到这一轮的 response.done 就挂；上游不回那一帧时不能让通话永远挂着
 * （按秒计费），到点强挂。
 */
export const VOICE_END_CALL_GOODBYE_TIMEOUT_MS = 5_000;

/**
 * 客户端断开后等它回来的宽限窗（批 H · 断线重连 sticky）。
 * 窗口内不挂断上游、不落通话摘要——否则每次网络抖动都会在消息流里落一张
 * 「通话结束」卡，然后重连变成第二通电话。超时才走正常 teardown。
 */
export const VOICE_RECONNECT_GRACE_MS = 15_000;

/** Renderer 侧重连退避（毫秒）。用完还没连上就如实报断线，不再假装还在通话。 */
export const VOICE_RECONNECT_BACKOFF_MS = [500, 1500, 4000] as const;

/**
 * Host 主动结束这一路时用的 WS close code（应用私有段 4000-4999）。
 *
 * 宽限窗只该服务网络抖动。host 侧终态（模型 end_call、watchdog/max-duration、上游死、
 * 互斥抢占）关的 WS 若与抖动无从区分，renderer 就会当断线接回来——2026-07-30 真机：
 * end_call 正常挂断 2 秒后自动重连出一通新电话（16 秒空通话、通话条不落、计时继续走，
 * 还落了一条「这通电话没有对话内容」摘要）。
 *
 * 结构化 close code 而不是末帧文本：renderer 无论有没有收到那一帧都判得准。
 */
export const VOICE_WS_CLOSE_TERMINAL = 4001;

/** 焦点上报最小间隔：这是 appStore 高频订阅，别每次面板切换都推一次 session.update。 */
export const VOICE_FOCUS_REPORT_MIN_INTERVAL_MS = 1000;

/** get_current_file_summary 兜底路径最多回几个文件路径，别把通话摘要撑成一屏。 */
export const VOICE_RECENT_FILE_LIMIT = 8;

/** 语音派发任务的迭代上限：通话场景的任务应该是小活，跑飞了要有个头。 */
export const VOICE_SPAWN_TASK_MAX_ITERATIONS = 30;

/**
 * 终态回流念出来的上限（字）。超过就截断并指路屏幕——一段话念过 15 秒，
 * 用户既插不上嘴也记不住，屏幕上本来就有全文。
 */
export const VOICE_NARRATION_MAX_CHARS = 120;

/**
 * 回头找「这一轮的结论」时往回翻几条消息。一轮 run 的尾部是 assistant 收尾语，
 * 中间隔的是工具调用消息；30 条足够跨过一轮的工具流，又不至于把上一件活的结论捞回来。
 */
export const VOICE_CONCLUSION_LOOKBACK_MESSAGES = 30;

/** Renderer→Host 媒体面 WS 路径。 */
export const VOICE_STREAM_WS_PATH = '/api/voice/stream';

/** Renderer→Host Dictation 流式识别 WS 路径。 */
export const DICTATION_STREAM_WS_PATH = '/api/voice/dictation';
