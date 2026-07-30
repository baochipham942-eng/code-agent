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
 * 800 档实测容住 450ms 停顿、600ms 才断。
 * silence 800→1000（批 X5，2026-07-30 真机：回显确认 800 已生效，真人犹豫仍被切断）。
 * 代价是收话判定又慢 200ms，已计入 ttfa 口径。
 * prefix 300→500：VAD 切分后的续段持续丢头（「叫」被吃、「内容」听成「总」），
 * 300ms 回补盖不住 onset 检测延迟。
 */
export const VOICE_TURN_DETECTION_DEFAULT: VoiceTurnDetectionConfig = {
  type: 'server_vad',
  threshold: 0.5,
  prefixPaddingMs: 500,
  silenceDurationMs: 1000,
};

/**
 * 历代 silence 默认值。prefix/silence 从来不是 UI 可设项，落盘里等于其中任何一个的值
 * 都只可能是「当年默认值随保存写死的拷贝」，不是用户的选择——读取口据此升级到新默认
 * （见 upgradeStaleVadDefaults）。手改过的其他值不在表里，原样保留。
 */
export const VOICE_STALE_SILENCE_DEFAULTS_MS = [500, 800] as const;

/** 同上，prefix 的历代默认值。 */
export const VOICE_STALE_PREFIX_DEFAULTS_MS = [300] as const;

/** 上行麦克风采样率（Hz），厂商要求 16k 单声道 PCM16。 */
export const VOICE_UPSTREAM_SAMPLE_RATE = 16_000;

/** 下行助手音频采样率（Hz），厂商固定 24k 单声道 PCM16。 */
export const VOICE_DOWNSTREAM_SAMPLE_RATE = 24_000;

/**
 * 字幕揭示器的推进间隔（ms）。
 *
 * 上游按**生成速度**吐转写（实测 124 字全文 544ms 到齐），而音频按**真实时间**播
 * （同一段 24.6 秒）——直接上屏就是字幕比语音早结束 20 多秒，肉眼看就是「攒整句一次性铺满」。
 * 所以字幕的揭示进度绑音频播放进度，这个间隔是推进节拍。
 */
export const VOICE_SUBTITLE_REVEAL_INTERVAL_MS = 100;

/**
 * 字幕揭示的停滞兜底（ms）：播放进度连续这么久没推进，就把剩余全文一次放完。
 *
 * 兜底存在的理由是「字幕绝不许永久悬着」——原生 AEC 走 sidecar、音频可能中途断供，
 * 没有这个闸，用户会对着半句话等到天荒地老。
 */
export const VOICE_SUBTITLE_STALL_FLUSH_MS = 3_000;

/**
 * 临时气泡等真消息上屏的最长时间（ms）。
 *
 * 撤气泡与真消息上屏必须原子，所以拉不到就重拉。等不到也**不撤**——顶着定稿文本
 * 至少画面是对的，撤了就是一段谁都没有这句话的空帧（R1 闪断）。这个上限只用来
 * 停掉重拉，避免落库真出问题时无限打 IPC。
 */
export const VOICE_PARTIAL_HANDOFF_MAX_WAIT_MS = 5_000;

/** Tauri 原生 AEC sidecar 的上行音频/电平/生命周期事件。 */
export const VOICE_AEC_OUTPUT_EVENT = 'voice-aec:output';

/** PCM 经 JSON IPC 传给 Rust 时的 base64 分块大小，避免一次展开大数组撑爆调用栈。 */
export const VOICE_AEC_BASE64_CHUNK_BYTES = 0x8000;

/**
 * relay 通话进入 live 后等待首个 Renderer 上行音频帧的窗口。
 * 正常原生 AEC 首帧实测 0.1–0.3s；8 秒足够覆盖启动和短抖动，又能在用户持续说话前留下明确 warn。
 */
export const VOICE_INBOUND_AUDIO_STARTUP_TIMEOUT_MS = 8_000;

/** 上游 WS 握手超时（ms）。 */
export const VOICE_UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** 上游 WS 心跳间隔（ms）；用于主动触发 TCP 层断链探测。 */
export const VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 上游完全无消息 / pong 的最长容忍时间（ms）= 心跳间隔 × 3。
 *
 * 写成倍数而不是裸数字，是因为这个值的含义是「连丢几拍才判死」：30_000 那版等于
 * **丢一拍就杀掉整通电话**（2026-07-30 真机 silenceMs=30225，派活等待期通话被判死，
 * 用户还在说话）。DashScope 的 WS pong 已实测支持（2026-07-30 探针：40s 空闲
 * 8/8 回 pong，RTT 50-170ms），所以单拍不回是丢包/迟到，连丢三拍才是真死。
 */
export const VOICE_UPSTREAM_SILENCE_TIMEOUT_MS = VOICE_UPSTREAM_HEARTBEAT_INTERVAL_MS * 3;

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
 * 用户说挂断的词表（A1，2026-07-30）。
 *
 * 模型嘴上答「好的，通话结束」却不调 end_call 已四次复现、prompt 强化三连败，
 * 所以挂断不再只挂在模型的自觉上：host 自己看用户 final 字幕，命中就走收线链。
 * 匹配规则见 hangupIntent.ts——**只认句尾**，「这个先这样处理然后继续」不算。
 *
 * 「挂断电话」「挂电话」单独成条：匹配是句尾比对，「挂断」这一条盖不住它们的尾巴。
 * 本次先做常量；「用户可配」记在 REPORT 遗留里。
 */
export const VOICE_HANGUP_INTENT_PHRASES = [
  '挂断',
  '挂断电话',
  '挂电话',
  '挂了',
  '结束通话',
  '结束对话',
  '先这样',
  '就这样',
  '拜拜',
  '再见',
  '回头聊',
  '下次聊',
  '不聊了',
] as const;

/**
 * 连续用户字幕并入上一条的时间窗（ms，R5）。VAD 把一句话切成几轮时，消息流里
 * 会留下一串碎片；这个窗口内到达的下一条 final 直接改写上一条，不新增消息。
 */
export const VOICE_TRANSCRIPT_MERGE_WINDOW_MS = 2_000;

/**
 * 告别播完之后再留给用户反悔的窗口（ms，E2）。
 *
 * 2026-07-30 真机：武装到挂断只隔 2 秒，因为触发点是 `response.done`——那是**模型
 * 生成完**，不是**用户听完**。告别音频那会儿才刚开始播，用户听到「好的拜拜」时
 * 通话早已 teardown，「不要挂断」根本没机会说出口。现在等音频真播完再加这个窗，
 * 代价是挂断慢 1-2 秒，换的是反悔真的来得及。
 */
export const VOICE_HANGUP_REACTION_WINDOW_MS = 1_500;

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
 * 完成语义证据查询的上限（X5.5-A2-a）。
 *
 * 为什么一次本地读盘也要设上限：这次查询卡在 run 终态**之前**，而终态那一步要还
 * D4 抬严票。查询永不返回 = 票永远不还 = 这条会话永久钉死在只读档，用户点什么都
 * 弹确认（本仓 2026-07-26 已被同一形状的锁死咬过一次）。超时按无证据处理（fail-closed）。
 */
export const VOICE_WORK_EVIDENCE_TIMEOUT_MS = 3_000;

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
