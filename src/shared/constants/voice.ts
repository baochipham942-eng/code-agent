// ============================================================================
// 实时语音（Realtime Voice）常量
// Phase 0 spike：仅 Qwen-Omni Realtime（DashScope，WebSocket 形态）。
// ============================================================================

import type { VoiceTurnDetectionConfig } from '../contract/voice';

/** ADR-054 Batch 2: 会话指挥台后台任务并发上限。 */
export const SESSION_TASK_CONCURRENCY = {
  global: 4,
  perSession: 2,
} as const;

/** 同一任务 lane 同时只允许一个 run，后续任务按 lane 串行。 */
export const SESSION_TASK_LANE_LIMIT = 1;

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

/**
 * 打断证据层（L2）的判别阈值。**当前处于 shadow mode，这四个值是占位口径**：
 * 真实分布（开电视 vs 正常对话两组）拿到之前，它们只决定采样时怎么标注，不决定行为。
 * 接进判定链之前必须按实测分布重定，别把占位值当结论。
 */

/** 触发速率的观察窗。电视人声在窗内会反复触发，真人打断是稀疏事件。 */
export const VOICE_INTERRUPT_BURST_WINDOW_MS = 20_000;

/** 窗内触发几次算「密集」。真机症状是 18 秒 4 次，故取 3 作为起判点。 */
export const VOICE_INTERRUPT_BURST_MIN_COUNT = 3;

/** 助手开口多久内被打断算「早重叠」。真人多在听懂几个字之后才插话。 */
export const VOICE_INTERRUPT_EARLY_OVERLAP_MS = 1_200;

/** 语音多长算「像一句真话」而不是一声杂音。 */
export const VOICE_INTERRUPT_SUBSTANTIVE_SPEECH_MS = 700;

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

/** response.created 后等待首增量或下一增量的绝对下限（ms）。 */
export const VOICE_UPSTREAM_RESPONSE_SILENCE_MIN_TIMEOUT_MS = 12_000;

/** 响应增量间隔的通话内滚动样本数；只留近期节奏，避免早期慢轮永久放宽看门狗。 */
export const VOICE_UPSTREAM_RESPONSE_SILENCE_SAMPLE_WINDOW = 12;

/** 滚动最大间隔的容忍倍数；真实节奏慢于绝对下限时自动放宽。 */
export const VOICE_UPSTREAM_RESPONSE_SILENCE_MULTIPLIER = 4;

/** 同一通话发生两次接管后，后续轮次的阈值收紧系数（仍不低于绝对下限）。 */
export const VOICE_UPSTREAM_RESPONSE_SILENCE_DEGRADED_FACTOR = 0.75;

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
 * 采到的屏幕上下文能等多久（Appshots Phase 3）。过了这个窗就不再附给新派的活。
 *
 * 为什么非有个上限不可：这张图是**一次性**跟着下一次派活走的，而「下一次派活」可能
 * 隔着好几轮闲聊才来。三分钟前的屏幕配一件毫不相干的新活，是在悄悄给执行侧喂错的
 * 事实——比不给更糟。三分钟按真机节奏取：指屏之后正常会在一两句话内派活，
 * 拖过三分钟的多半已经在聊别的了。
 */
export const VOICE_SCREEN_CONTEXT_TTL_MS = 3 * 60 * 1_000;

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
 * 「停旧的」等终态事件的上限（ms，§1 打断原子性）。
 *
 * 这个值不是随便定的：防双跑的硬门是「确认终态前绝不 startRun」，所以超时的后果是
 * **新活不派**——定太短会把正常的 cancel 判成失败、白白丢掉用户的替换意图；定太长
 * 则用户在电话里干等。cancelTask 到 task_cancelled 正常是一次 orchestrator 中断，
 * 5 秒足够覆盖，且与竞品的总等待窗同量级。
 */
export const VOICE_STOP_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * 停不下来时重发 cancel 的次数。**只重发 cancel，不重发 startRun**——
 * startRun 一次都还没发生过（硬门），这里重试的是「让旧的停下来」这个动作本身。
 */
export const VOICE_STOP_CONFIRM_RETRIES = 1;

// ----------------------------------------------------------------------------
// 中途进度口播（§2 milestone）。
//
// 这四个常量存在的理由是同一个：**milestone 会把注入频率提高数倍**。终态每件活只播
// 一次，milestone 是过程量，不设闸就会变成一个在你耳边碎碎念的助手——而且它撞上的是
// 一条已知会哑火的上游链路（「对 committed 轮可能永久哑火」），频率一高，撞击面同步放大。
// ----------------------------------------------------------------------------

/** 每件活最多播几条进度。超过就沉默——剩下的进展等终态一起说。 */
export const VOICE_MILESTONE_MAX_PER_WORK_ITEM = 3;

/** 两条进度之间的最小间隔。比这密就是碎碎念。 */
export const VOICE_MILESTONE_MIN_INTERVAL_MS = 20_000;

/**
 * 派活后第一条进度的最小延迟。
 *
 * 没有它的话，「我开始做 X 了」和第一条进度会挤在同一口气里——用户刚听完开场白就被
 * 追加一句进展，听起来像系统在自言自语。
 */
export const VOICE_MILESTONE_FIRST_DELAY_MS = 800;

/**
 * 进度的保质期。排队超过这个时长的直接丢弃，不播。
 *
 * 进度是**过程量**：它只在「正在发生」的时候有信息量。被压了一分钟才播出来的进度，
 * 说的是一分钟前的事，而用户此刻关心的是现在——播出来只会误导。终态不受此限（结论
 * 永远值得说），被同一件活的终态覆盖的进度同样直接丢。
 */
export const VOICE_MILESTONE_STALE_MS = 60_000;

/** 播报注入后等待 Renderer 确认真正开始播放的窗口。 */
export const VOICE_NARRATION_PLAYBACK_ACK_TIMEOUT_MS = 5_000;

/** 未确认播报的指数退避基数与封顶；第 n 次等待为 base * 2^n。 */
export const VOICE_NARRATION_RETRY_BASE_MS = 500;
export const VOICE_NARRATION_RETRY_MAX_MS = 8_000;

/** 终态播报最多重试次数；首次注入不计入 retries。 */
export const VOICE_NARRATION_MAX_RETRY_ATTEMPTS = 8;

/** 外部文字/播报注入等待上游创建 response 的确认窗。 */
export const VOICE_INJECTION_ACK_WINDOW_MS = 5_000;

/** XML 工具降级块的最大字符数；超限直接拒绝，避免无界缓存模型输出。 */
export const VOICE_XML_FALLBACK_MAX_CHARS = 16_384;

/**
 * 回头找「这一轮的结论」时往回翻几条消息。一轮 run 的尾部是 assistant 收尾语，
 * 中间隔的是工具调用消息；30 条足够跨过一轮的工具流，又不至于把上一件活的结论捞回来。
 */
export const VOICE_CONCLUSION_LOOKBACK_MESSAGES = 30;

// ── 声纹身份（N-L7-SPK）─────────────────────────────────────────────
// 只用于个性化与消歧，绝不当认证用（工单 §5 硬边界）。

/** 通话内活跃说话人匹配阈（cosine）。TTS spike：同人 0.86 / 异人 0.60~0.71，真机再调。 */
export const VOICEPRINT_MATCH_THRESHOLD = 0.6;

/** 跨会话认本人阈（cosine）。跨会话信道/状态漂移更大，比通话内阈低一档。 */
export const VOICEPRINT_OWNER_THRESHOLD = 0.55;

/** 短于此的片段不做声纹判定（embedding 不可靠），verdict=unknown → fail-open。 */
export const VOICEPRINT_MIN_SEGMENT_MS = 600;

/** 长片段只取前这么多毫秒做 embedding，推理耗时封顶。 */
export const VOICEPRINT_MAX_SEGMENT_MS = 10_000;

/** 上行 PCM 环形缓冲长度。16k PCM16 mono ≈ 960KB，仅内存，通话结束即丢。 */
export const VOICEPRINT_RING_BUFFER_MS = 30_000;

/** 切片时在 speech_started 之前多带的前缀，对齐上游 VAD prefix_padding_ms。 */
export const VOICEPRINT_SEGMENT_PREFIX_MS = 500;

/** 本人声纹保留期：长期未命中自动删除。这个数字会写进设置页文案，用户看得到。 */
export const VOICEPRINT_RETENTION_DAYS = 90;

/** 本人声纹最多存几条 embedding 样本（超上限丢最旧）。 */
export const VOICEPRINT_MAX_OWNER_EMBEDDINGS = 3;

/** CAM++ zh-cn 输出维度（ONNX 实测 [1,192]）。 */
export const VOICEPRINT_EMBEDDING_DIM = 192;

/** 声纹数据目录名（位于用户数据目录下）与档案文件名。 */
export const VOICEPRINT_DIR = 'voiceprint';
export const VOICEPRINT_PROFILE_FILE = 'owner-profile.json';

/**
 * 声纹推理复用桌面 VAD 那份 ONNX 运行时按需资产（同一个 onnxruntime-node）。
 * 只在 darwin-arm64 有产物，其余平台拿不到就维持缺失态。
 */
export const VOICEPRINT_ONNX_ASSET_ID = 'onnxruntime-vad';

/** 模型缓存目录（按需下载落这里；与声纹数据目录分开——模型是组件，不是身份数据）。 */
export const VOICEPRINT_MODEL_DIR = 'voiceprint-model';
export const VOICEPRINT_MODEL_FILE = 'campplus-zh-cn-16k-common.onnx';

/**
 * CAM++ zh-cn ONNX（3D-Speaker 官方模型的 sherpa-onnx 导出件，fp32 27MB）。
 * URL/SHA256 成对钉死；换模型两个一起换。真机核过：SHA256 与下载件一致。
 */
export const VOICEPRINT_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
export const VOICEPRINT_MODEL_SHA256 =
  'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11';

/** Renderer→Host 媒体面 WS 路径。 */
export const VOICE_STREAM_WS_PATH = '/api/voice/stream';

/** Renderer→Host Dictation 流式识别 WS 路径。 */
export const DICTATION_STREAM_WS_PATH = '/api/voice/dictation';
