// ============================================================================
// Settings Types
// ============================================================================

import type { AgentEngineKind, ExternalAgentEngineKind } from './agentEngine';
import type {
  ModelConfig,
  ModelProvider,
  ModelProviderProtocol,
  ModelThinkingPreference,
} from './model';
import type { ModelCapability } from './model';
import type { PermissionLevel } from './tool';
import type { ContextCompressionConfig } from './contextHealth';
import type { RoleProactivitySettings } from './roleAssets';
import type { SpeechInputSettings } from './speech';
import type { VoiceTurnDetectionConfig } from './voice';
import type { KeybindingsSettings } from '../keybindings';
import type { RealtimeVoiceProviderId } from '../constants/realtimeVoiceProviders';

export interface CustomRealtimeVoiceProviderSettings {
  /** Stable user-defined id. Keys are isolated by this id in secure storage. */
  id: string;
  displayName: string;
  /** Exact WSS endpoint. `model` is added as a query parameter when absent. */
  endpoint: string;
  authStyle: 'bearer';
  sessionShape: 'openai-realtime';
  model: string;
  voices: string[];
  defaultVoice: string;
  inputSampleRate: 16_000 | 24_000;
  outputSampleRate: 24_000;
  createdAt: number;
  updatedAt: number;
}

/** 未配置实时语音总开关时的产品默认；显式 false 仍表示用户主动关闭。 */
export const VOICE_LIVE_ENABLED_DEFAULT = true;

export function resolveVoiceLiveEnabled(
  live: Pick<VoiceLiveSettings, 'enabled'> | undefined,
): boolean {
  return live?.enabled ?? VOICE_LIVE_ENABLED_DEFAULT;
}

/** 实时通话（Live Voice）UI 设置。全部可选，未配置 = 入口开启、Provider 默认档。 */
export interface VoiceLiveSettings {
  /** 总开关：undefined = 默认开启；false = Composer 不显示实时通话入口 */
  enabled?: boolean;
  /** 单通实时语音预估成本上限；未配置或 <=0 = 不设限。 */
  callCostLimit?: number;
  /** 到限动作：默认只提醒；用户可显式改为自动挂断。 */
  callCostLimitAction?: 'warn' | 'hangup';
  /**
   * 实时语音 Provider。存量配置没有该字段时读取为 DashScope；
   * 不在注册表里的值同样 fail-closed 到 DashScope。
   */
  providerId?: RealtimeVoiceProviderId;
  /** Non-sensitive custom Provider metadata. API keys never enter settings. */
  customProviders?: CustomRealtimeVoiceProviderSettings[];
  /**
   * 音色。枚举与当前 Provider profile 的通话模型强绑定；
   * 读取时会归一到该 profile 的合法值，换模型必须同步归一音色。
   */
  voiceId?: string;
  /**
   * 通话模型（负责听和说的实时模型）：只能是当前 Provider profile
   * 注册的模型；未配置 / 表外 id 会回落该 profile 的默认模型。
   * 音色与模型强绑定：换模型时 voiceId 必须一起落到新模型的 voices 里。
   */
  conversationModel?: string;
  /** 通话语言；auto/未配置 = 跟随上游自动检测 */
  language?: 'auto' | 'zh' | 'en';
  /**
   * 打断方式：
   * - `server_vad`（默认）：全双工自动断句，灵敏度由 vadSensitivity 映射 turn_detection.threshold；
   * - `manual`：点按开始说话、再点按提交（turn_detection = null + commit），背景有人声时用。
   *
   * 2026-07-27 删掉 `push_to_talk`（按住说话）：它相对 `manual` 只多一条「松手必关麦」，
   * 代价是整通电话手被按在按钮上，桌面端不值。历史值由 normalizeInterruptMode 迁到 manual。
   */
  interrupt?: 'server_vad' | 'manual';
  /** server_vad 灵敏度档位：high 灵敏（threshold 0.3）/ medium（0.5）/ low 迟钝（0.7） */
  vadSensitivity?: 'low' | 'medium' | 'high';
  /**
   * 语音派活时的执行引擎（方案 §6.1 双脑：通话模型只负责听说，干活是另一个模型）。
   * 未配置 = 跟随会话默认引擎，与批 H 之前的行为完全一致。
   * 通话模型（听说）在上面的 conversationModel 配，白名单见 QWEN_OMNI_REALTIME_MODEL_OPTIONS。
   */
  executionModel?: { provider: string; model: string };
  /** 回声消除：auto 优先原生 AEC；off 强制走耳机模式。未配置 = auto。 */
  echoCancellation?: 'auto' | 'off';
  /** 通话语速。纯 instructions 指令，遵从度按 Provider 不保证。未配置 = normal。 */
  speechRate?: 'slow' | 'normal' | 'fast';
}

/**
 * 语音采集输入设备。WebRTC deviceId 与 CoreAudio UID 不互通，因此 label 是
 * Web / 原生两条采集链的持久化对账键；webDeviceId 只作 Web 路快速命中缓存。
 */
export interface VoiceInputDeviceSettings {
  label: string;
  webDeviceId?: string;
}

export interface ModelEntrySettings {
  enabled?: boolean;
  label?: string;
  capabilities?: ModelCapability[];
  maxTokens?: number;
  /** 输入上下文上限（发现时从 provider /models 的 context_length 捕获） */
  contextWindow?: number;
  supportsTool?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  /** 单模型 thinking 偏好；能力形态由对应 ModelInfo.thinking 决定。 */
  thinking?: ModelThinkingPreference;
  discoveredAt?: number;
}

/** provider 代理模式：'auto'=按内置 OVERSEAS_PROVIDERS 判断；'direct'=强制直连；'proxy'=强制走代理。 */
export type ProxyMode = 'auto' | 'direct' | 'proxy';

export interface ModelProviderSettings {
  apiKey?: string;
  apiKeyConfigured?: boolean;
  /** 用户是否启用该 Provider 入口。仅表示入口开关，不代表当前运行时可用。 */
  enabled: boolean;
  /** 当前运行时是否可用；Local/Ollama 由本机发现刷新，不由 enabled 推导。 */
  available?: boolean;
  /** 最近一次 Provider 级发现时间；模型级发现时间仍记录在 models[*].discoveredAt。 */
  discoveredAt?: number;
  unavailableReason?: string;
  protocol?: ModelProviderProtocol;
  model?: string;
  baseUrl?: string;
  displayName?: string;
  /** Provider 图标：短文本标识（最多两个可见字符）、受限 data:image，或 provider-icon://local 本机资产引用，用于设置页和会话页快速识别 provider。 */
  icon?: string;
  /** 常用 provider 标记；仅影响 UI 排序和标识，不改变路由策略。 */
  favorite?: boolean;
  temperature?: number;
  maxTokens?: number;
  updatedAt?: number;
  /** 该 provider 的最大并发请求数。留空/0 = 不限流（沿用内置默认，未声明则完全放行）。
   *  填正数则启用自适应并发限流器（命中 429 自动降级，5 分钟无限流后逐步恢复）。 */
  maxConcurrent?: number;
  /** 该 provider 走代理还是直连。'auto'（默认）按内置 OVERSEAS_PROVIDERS 判断；
   *  'direct' 强制直连；'proxy' 强制走全局 HTTPS_PROXY。覆盖内置 providerNeedsProxy 判断。 */
  proxyMode?: ProxyMode;
  /** 该 provider 的计费方式（ADR-019 计费语义四分类）：
   *  'free'=官方免费 / 'plan'=套餐内（包月/订阅）/ 'payg'=按量付费 / 'unknown'=无法确认。
   *  未设置时：普通 provider 默认 payg（API Key 主流形态），动态 custom provider（中转站）默认 unknown。
   *  自动模式的 simple→免费档路由仅在 payg 时生效（包月切免费省的钱是 0）。 */
  billingMode?: 'free' | 'plan' | 'payg' | 'unknown';
  /** true=该 provider 由控制面下发的团队共享 provider（中转站）托管，由 reconcile 自动增删，
   *  用户不应手动编辑；控制面停发（管理员关闭/吊销）后会在下次拉取时被自动移除。 */
  managedByCloud?: boolean;
  models?: Record<string, ModelEntrySettings>;
}

export interface AgentEngineModelPreferenceSettings {
  defaultModel?: string;
  updatedAt?: number;
}

export type TaskStrategyMode = 'auto' | 'manual';
export type TaskStrategyProfileId = 'fast' | 'main' | 'deep' | 'vision';
export type TaskStrategyRuleIntent = 'simple_chat' | 'coding' | 'research' | 'vision' | 'artifact';

export interface TaskStrategyModelSlot {
  provider: ModelProvider;
  model: string;
  reasoningEffort?: ModelConfig['reasoningEffort'];
  maxTokens?: number;
}

export interface TaskStrategyRuleSettings {
  id: string;
  label: string;
  intent: TaskStrategyRuleIntent;
  enabled: boolean;
  profile: TaskStrategyProfileId;
  reason: string;
}

export interface TaskModelStrategySettings {
  mode: TaskStrategyMode;
  defaultProfile: TaskStrategyProfileId;
  profiles: Record<TaskStrategyProfileId, TaskStrategyModelSlot>;
  fallback: {
    enabled: boolean;
    preferSameProvider: boolean;
    allowCrossProvider: boolean;
  };
  rules: TaskStrategyRuleSettings[];
  updatedAt?: number;
}

export interface AppSettings {
  models: {
    default: string;
    defaultProvider?: ModelProvider;
    providers: Record<string, ModelProviderSettings>;
    agentEngines?: Partial<Record<ExternalAgentEngineKind, AgentEngineModelPreferenceSettings>>;
    // 按用途选择模型
    routing: {
      code: { provider: ModelProvider; model: string };
      vision: { provider: ModelProvider; model: string };
      fast: { provider: ModelProvider; model: string };
      gui: { provider: ModelProvider; model: string };
    };
    taskStrategy?: TaskModelStrategySettings;
  };
  onboarding?: {
    completedAt?: number;
    defaultEngine?: AgentEngineKind;
  };
  // 联网搜索源配置（ADR-026）。全部可选，未配置 = 现状行为不变。
  // 注：搜索 API key 仍由 secureStorage / configService 管，不存于此。
  search?: {
    /** 用户禁用的搜索源 id（从可用源中排除） */
    disabledSources?: string[];
    /** 源优先级覆盖（id 顺序，越靠前越优先；未列出的按内置 priority 排在后） */
    sourceOrder?: string[];
  };
  // 生成模型默认值（ADR-027）。全部可选，未配置 = 设计画布仍用 registry 首项。
  // 模型 id 须为 visualModels.ts 的 IMAGE_MODELS / VIDEO_MODELS 中的 id。
  design?: {
    /** 默认图像生成模型 id */
    defaultImageModelId?: string;
    /** 默认视频生成模型 id */
    defaultVideoModelId?: string;
  };
  // 实时语音配置。全部可选，未配置 = 使用 Provider 默认安全档。
  voice?: {
    /** 上游断句策略；null 表示手动 commit 模式 */
    turnDetection?: VoiceTurnDetectionConfig;
    /** 口述专名词表；Host 会在注入前统一清洗与限长 */
    vocabulary?: string[];
    /**
     * 麦克风输入设备；`null` 是用户明确选择「系统默认」的持久化清除值。
     * 设备消失、配置缺失或形状无效时，采集链同样回落系统默认。
     */
    inputDevice?: VoiceInputDeviceSettings | null;
    /** 实时通话（Live Voice）UI 设置；运行时断句真源仍是上面的 turnDetection */
    live?: VoiceLiveSettings;
  };
  // API 超时配置
  timeouts?: {
    /** 任务复杂度（用户设置） */
    complexity: 'simple' | 'medium' | 'complex';
    /** 简单任务超时（毫秒），默认 30000 */
    simple: number;
    /** 中等任务超时（毫秒），默认 120000 */
    medium: number;
    /** 复杂任务超时（毫秒），默认 600000 */
    complex: number;
    /** 自定义超时（毫秒），用户可手动设置 */
    custom?: number;
  };
  workspace: {
    defaultDirectory?: string;
    recentDirectories: string[];
    /**
     * 默认打开目标：启动时如何决定 working directory。
     * - 'lastDirectory'（默认）：使用最近一次的目录（即 recentDirectories[0] 或 defaultDirectory）。
     * - 'fixedDirectory'：每次启动都进 pinnedDirectory，忽略最近目录。
     * - 'askEachTime'：启动时不预设 cwd，由用户在 UI 里选择。
     */
    defaultOpenTarget?: 'lastDirectory' | 'fixedDirectory' | 'askEachTime';
    /** 当 defaultOpenTarget === 'fixedDirectory' 时使用的目录路径。 */
    pinnedDirectory?: string;
  };
  permissions: {
    autoApprove: Record<PermissionLevel, boolean>;
    blockedCommands: string[];
    devModeAutoApprove: boolean; // Development mode: auto-approve all permissions
    /** 权限模式（新会话默认权限档），持久化存储（重启/重装后恢复） */
    permissionMode?: 'default' | 'readOnly' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate';
    /**
     * 子 agent 权限继承策略（M2-Task 5 partial — childContext only）
     * - strict-inherit（默认）：子 = 父真子集；tools ∩、deny ∪、mode 取更严，永不扩张
     * - child-narrow：子可在父集合内声明更窄能力（仅父 mode ∈ {default, acceptEdits} 时允许子放宽 allow）
     * - independent：子完全独立（仍受 GuardFabric topology + 用户 deny 约束）
     *
     * 未设置时按 `strict-inherit` 处理；首次升级老配置时打 `_legacyPermissions=true` 标记触发引导。
     */
    inheritance?: 'strict-inherit' | 'child-narrow' | 'independent';
    /** 用户级 deny 规则（tool specifier 语法，例：'Bash(rm -rf *)'、'Write(/etc/*)'） */
    deny?: string[];
    /** 用户级 ask 规则 */
    ask?: string[];
    /** 用户级 allow 规则（最低优先级，不能压过 deny） */
    allow?: string[];
    /**
     * 内部标记：true 表示配置升级到 6.8.x 但用户尚未显式声明 inheritance。
     * UI 检测到该标记会弹一次性引导，提醒用户选择继承策略。
     */
    _legacyPermissions?: boolean;
    /**
     * P6 grandfathering：升级 banner 已被用户 ack（点击"知道了"或显式选择
     * inheritance 后置 true）。为 true 时不再弹引导，保证一次性。
     */
    inheritanceMigrationAcked?: boolean;
  };
  ui: {
    theme: 'light' | 'dark' | 'system' | 'high-contrast-light' | 'high-contrast-dark';
    fontSize: number;
    showToolCalls: boolean;
    language: 'zh' | 'en';
    disclosureLevel?: 'simple' | 'standard' | 'advanced' | 'expert';
    /** 开发者模式：在对话流中显示回合质量评分、路由详情等调试信息 */
    developerMode?: boolean;
  };
  // 云端 Agent 配置
  cloud: {
    enabled: boolean;
    endpoint?: string;
    apiKey?: string;
    warmupOnInit: boolean;
  };
  // GUI Agent 配置
  guiAgent: {
    enabled: boolean;
    displayWidth: number;
    displayHeight: number;
  };
  // MCP 配置
  mcp?: {
    servers: Array<{
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      enabled: boolean;
    }>;
  };
  // 原生连接器（macOS Calendar/Mail/Reminders）— 默认全关，按需激活
  connectors?: {
    enabledNative: string[];
  };
  // Session 配置
  session?: {
    autoRestore: boolean;
    maxHistory: number;
  };
  // Model 配置 (简化访问)
  model?: {
    provider: ModelProvider;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  // Supabase 配置 (云端同步)
  supabase?: {
    url: string;
    anonKey: string;
  };
  // Cloud API 配置 (更新检查等)
  cloudApi?: {
    url: string;
  };
  // Langfuse 配置 (可观测性)
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    /** 旧遥测开关字段：privacy.usageDataEnabled 缺省时作为兼容回退（见 shared/observability/privacyFlags.ts） */
    enabled?: boolean;
  };
  // 隐私开关（承诺 → 通道的映射统一在 host 侧 privacyGate，两个开关都必须真接线）
  privacy?: {
    /** 使用数据：LLM tracing（Langfuse）+ 产品分析（PostHog）+ fleet telemetry（Supabase）。缺省 = 开 */
    usageDataEnabled?: boolean;
    /** 崩溃报告：Sentry node + renderer。缺省 = 开 */
    crashReportingEnabled?: boolean;
  };
  // 安全校验配置
  sanitization?: {
    mode: 'strict' | 'moderate' | 'permissive';
  };
  // 确认门控配置
  confirmationGate?: {
    policy: 'always_ask' | 'always_approve' | 'ask_if_dangerous' | 'session_approve';
    overrides?: Record<string, 'always_ask' | 'always_approve' | 'ask_if_dangerous' | 'session_approve'>;
  };
  // Budget 配置 (成本控制)
  budget?: {
    enabled: boolean;
    /** 最大预算 (USD) */
    maxBudget: number;
    /** 静默日志阈值 (默认 0.7 = 70%) */
    silentThreshold?: number;
    /** 警告阈值 (默认 0.85 = 85%) */
    warningThreshold?: number;
    /** 阻断阈值 (默认 1.0 = 100%) */
    blockThreshold?: number;
    /** 重置周期 (小时, 默认 24) */
    resetPeriodHours?: number;
  };
  // 上下文压缩配置
  contextCompression?: ContextCompressionConfig;
  // Appshots（左右 Command 双击抓窗口截图+文本送进 composer）
  appshots?: {
    /** 是否启用左右 Command 双击热键 */
    enabled: boolean;
    /** 截图送往：当前会话 / 每次新建会话 */
    targetSession: 'current' | 'new';
  };
  // 会话页语音输入（桌面 mic -> ASR -> composer draft）。渠道语音消息不复用这套设置。
  speech?: SpeechInputSettings;
  // 用户可见快捷键配置。native 全局热键注册另走平台层，先由设置与 UI 共享同一份 registry。
  keybindings?: KeybindingsSettings;
  // 持久化角色资产（内部文档 §4：主动性用户级配置）
  roleAssets?: {
    proactivity?: RoleProactivitySettings;
  };
}
