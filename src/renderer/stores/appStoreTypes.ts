// ============================================================================
// App Store Types - appStore 的纯类型/常量面
// （N-MAXLINES-MINEFIELD-2-FU1-S10 自 appStore.ts 原样搬移；appStore.ts import 自用并
// 逐名 re-export，公共导出面不变，消费方零改动。CloudUIStrings 保持原状不导出——
// 唯一消费方 AppState 同在本文件，导出反而构成 dead export。）
// ============================================================================
import type {
  DeliverableEvidenceStatus,
  ErrorRecord,
  Finding,
  ModelConfig,
  PermissionRequest,
  TaskCompleteData,
  TaskPlan,
  TaskProgressData,
  UpdateInfo,
} from '@shared/contract';
import type { GoalGateVerificationCard } from '@shared/contract/agent';
import type { GoalRunInput } from '@shared/contract/appService';
import type { ContextHealthState } from '@shared/contract/contextHealth';
import type { Language } from '../i18n';
import type { SettingsTab, CapabilityHubTab } from '../utils/settingsTabs';
import type { WorkbenchTabId, WorkbenchViewId } from '../utils/workbenchViews';

// 渐进披露级别
export type DisclosureLevel = 'simple' | 'standard' | 'advanced' | 'expert';

// 云端 UI 字符串类型
type CloudUIStrings = {
  zh: Record<string, string>;
  en: Record<string, string>;
};

export type TaskPanelTab = 'monitor' | 'orchestration';
/** 「本机操作」整窗页的页内 tab：桌面操作 / 浏览器（2026-07-26 导航去重方案 9 合并页）。 */
export type LocalOpsTab = 'desktop' | 'browser';
export type ContentPreviewInput = { id: string; title: string; content: string; format: 'html' | 'markdown' | 'json' | 'text' };

// Preview tab — one per opened file, generated in-memory artifact, or live dev server.
export interface PreviewTab {
  id: string;
  path: string;
  content: string;      // editor buffer (may differ from saved)
  savedContent: string; // last-known on-disk content
  mode: 'preview' | 'source' | 'edit';
  lastActivatedAt: number;
  isLoaded: boolean;    // whether readFile has populated savedContent yet
  reloadNonce?: number; // disk refresh trigger even when isLoaded is already false
  // Live Preview (D3+) — 存在时覆盖文件语义
  kind?: 'file' | 'virtual' | 'liveDev';
  /** Human title for generated content that has no on-disk path. */
  title?: string;
  devServerUrl?: string;
  /** V2-A: Code Agent 自起的 dev server session id；用户外部起的 dev server 留空 */
  devServerSessionId?: string;
  selectedElement?: LivePreviewSelectedElement | null;
  // D6: 外部驱动的编辑器跳转（file tab 使用）
  jumpToLine?: number;
  jumpNonce?: number;
  /** 从产物卡打开时携带的验证结论，只在右侧预览详情中展示。 */
  deliverableStatus?: DeliverableEvidenceStatus;
}

// Bridge 回传的元素信息（保持与 shared/livePreview/protocol.ts 中 SelectedElementInfo 同形）
export interface LivePreviewSelectedElement {
  /** 绝对路径（resolveSourceLocation 规范化后），composer 注入 envelope 用这个 */
  file: string;
  /** 原始相对路径（bridge 里 data-code-agent-source 存的形），用于 HMR vg:restore-selection 反查 DOM */
  relativeFile: string;
  line: number;
  column: number;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string;
  /** V2-B (protocol 0.3.0) — DOM class 属性当前值，TweakPanel 解析展示 */
  className?: string;
  /** V2-B (protocol 0.3.0) — getComputedStyle 子集，TweakPanel 渲染当前值 */
  computedStyle?: import('@shared/livePreview/protocol').ComputedStyleSnapshot;
}

// Max open preview tabs. When exceeded, the least-recently-activated tab is evicted.
export const MAX_PREVIEW_TABS = 8;

export type WorkbenchOpenSource = 'user' | 'auto';

export interface OpenWorkbenchTabOptions {
  source?: WorkbenchOpenSource;
  deliverableStatus?: DeliverableEvidenceStatus;
  /** Background auto-open creates/refreshes the tab without stealing the active view. */
  activate?: boolean;
}

// 跨 panel 跳转目标
// kind 决定跳到哪个 tab 并 highlight；name 是被高亮的项标识
export interface WorkbenchHighlight {
  kind: 'skill' | 'mcp' | 'subagent';
  name: string;
  nonce: number;
}

export interface SettingsMemoryFocus {
  filename?: string;
  query?: string;
  nonce: number;
}

export interface SettingsCapabilityFocus {
  kind: 'skill' | 'mcp' | 'connector';
  id: string;
  nonce: number;
  /** 深链来源：'onboarding' = 首启引导（落页横幅按引导措辞、只展示显示名）；缺省 = 会话页 */
  source?: 'onboarding' | 'external-import';
}

/** /goal 自治模式的前端运行态（per-session，由 SSE goal_* 事件驱动）。 */
export interface GoalRunState {
  /** 目标文本（"开启目标：xxx" 展示用） */
  goal: string;
  /** 开始时间戳（计时器据此算已运行时长） */
  startedAt: number;
  /** 运行态：running 进行中 / paused 用户暂停（③，循环在 turn 边界挂起，goal 仍 pending）/ met 达成 / aborted 兜底中止 */
  status: 'running' | 'paused' | 'met' | 'aborted';
  /** 当前第几轮 */
  turn: number;
  /** 轮次上限 */
  maxTurns: number;
  /** 已用 token */
  tokensUsed: number;
  /** token 预算 */
  tokenBudget: number;
  /** 墙钟时间预算（ms）；undefined = 不限时（①，StatusBar 据此显示剩余时间） */
  wallClockBudgetMs?: number;
  reason?: string;
  /** 到限放行：met 但验证未全过（修复预算耗尽，安静降级标识） */
  degraded?: boolean;
  /** 结束时间戳（met/aborted 后用于停表 + 展示总耗时） */
  finishedAt?: number;
  /** 最近一次闸判定（UI 可显示"验证中/评审中"反馈） */
  lastGate?: { gate: number; pass: boolean; reason?: string; verificationCard?: GoalGateVerificationCard };
  /** goal gate history for final verification card rendering. */
  gates: Array<{ gate: number; pass: boolean; reason?: string; verificationCard?: GoalGateVerificationCard }>;
}

export interface PendingProjectGoalChatSeed {
  sessionId: string;
  content: string;
  goal: GoalRunInput;
}

/**
 * 设置页的用户关闭落点（Stripe portal return_url 模式）：从二级页（目前只有自动化的
 * webhook 门）「去设置」时记下来源页，用户关闭设置（X / Esc）时直接回该页而不是聊天首页。
 */
export type SettingsReturnTo = 'cronCenter';

export interface AppState {
  // UI State
  showSettings: boolean;
  /** 非空 = 这次设置是带返回落点打开的；closeSettings 据此决定关了落哪儿。 */
  settingsReturnTo: SettingsReturnTo | null;
  settingsInitialTab: SettingsTab | null; // 打开设置时默认选中的 Tab
  settingsMemoryFocus: SettingsMemoryFocus | null;
  settingsCapabilityFocus: SettingsCapabilityFocus | null;
  /**
   * 「把光标放回输入框」的请求信号：递增即触发一次，ChatInput 监听变化后 focus。
   * 用于「新建会话」落在一个已经打开的空白草稿上——此时没有任何可见变化，
   * 点击看起来像没反应；聚焦输入框是这次点击唯一诚实的回执。
   */
  composerFocusNonce: number;
  // 对话式建角色：待发送的种子消息（入口触发，ChatView 在新会话就绪后自动发出）
  pendingRoleChatSeed: string | null;
  // 项目目标：从 Project 详情/控制台启动后，等目标 session 成为当前会话再自动发出 /goal envelope
  pendingProjectGoalChatSeed: PendingProjectGoalChatSeed | null;
  // 项目协作空间底部输入框：新会话成为当前会话后自动发出的首条消息
  showPromptManager: boolean;
  showWorkspace: boolean;
  taskPanelTab: TaskPanelTab;
  showAgentTeamPanel: boolean;
  selectedSwarmAgentId: string | null;
  /** 当前会话的显式 agent 选择（per-session 作用域，随会话切换同步；持久化到 per-session map）。 */
  activeAgentId: string | null;
  /** activeAgentId 当前绑定的会话 id；null = draft（尚无会话）。 */
  activeAgentSessionKey: string | null;
  showCapturePanel: boolean;
  showDesktopPanel: boolean;
  /** 「本机操作」合并整窗页（桌面操作 + 浏览器，页内 tab 切换）。 */
  showLocalOpsPanel: boolean;
  /** browser-control 共用的应用内验证工作台，独立于内部评测中心。 */
  showInAppValidation: boolean;
  activeInternalFeatureId: string | null;
  /** 本机操作页当前 tab；openLocalOpsPanel 可带 tab 深链。 */
  localOpsTab: LocalOpsTab;
  pendingInAppValidationRequest: import('@shared/contract/browserInteraction').InAppValidationRequest | null;
  showProjectCollaborationPage: boolean;
  projectCollaborationPageProjectId: string | null;
  /** 项目列表页 + 项目协作空间页（批P）：页内 list/space 视图切换不进 store */
  showProjectSpacePage: boolean;
  showActivityPanel: boolean;
  showCapabilityHub: boolean;
  capabilityHubTab: CapabilityHubTab;
  showCronCenter: boolean;
  showTimeCapabilityCenter: boolean;
  showFileExplorer: boolean;
  voicePasteStatus: 'idle' | 'recording' | 'transcribing' | 'processing';
  sidebarCollapsed: boolean;
  optionalUpdateInfo: UpdateInfo | null;
  showOptionalUpdateModal: boolean;

  // 语言设置 - Language
  language: Language;

  // 云端 UI 字符串（热更新）
  cloudUIStrings: CloudUIStrings | null;

  // 渐进披露 - Progressive Disclosure
  disclosureLevel: DisclosureLevel;

  // 开发者模式：对话流中显示回合质量评分等调试信息
  developerMode: boolean;


  // Chat State (messages/todos/currentSessionId 已迁移到 sessionStore)
  isProcessing: boolean;
  // 按会话追踪处理状态（支持多会话并发）
  processingSessionIds: Set<string>;

  // Planning State (for Gen 3+ persistent planning)
  taskPlan: TaskPlan | null;
  findings: Finding[];
  errors: ErrorRecord[];

  // DAG Visualization State (任务执行图可视化)
  showDAGPanel: boolean;

  // Lab State (实验室)
  showLab: boolean;

  // V2-A: DevServerLauncher 模态可见性。true 时 App 渲染 <DevServerLauncher />
  devServerLauncherOpen: boolean;

  // Batch 2 L3: 资料库全屏页可见性
  showLibraryPanel: boolean;

  /** 当前全屏专家详情页；关闭后回到能力中心的专家 tab。 */
  expertDetailRoleId: string | null;

  // File preview tab registry — one entry per opened file (content, dirty state, LRU).
  previewTabs: PreviewTab[];
  activePreviewTabId: string | null;

  // Unified right workbench — only the five canonical view categories are stored.
  // Retired WorkbenchTabId values are accepted by actions as deep-link aliases.
  workbenchTabs: WorkbenchViewId[];
  activeWorkbenchTab: WorkbenchViewId | null;
  workbenchBySession: Record<string, {
    tabs: WorkbenchViewId[];
    active: WorkbenchViewId | null;
  }>;
  workbenchSessionKey: string | null;
  /**
   * 右栏整栏收起。页签全部关闭时整栏自动收起；打开视图则带出右栏。
   * auto 源仍尊重 workbenchCollapsedByUser，避免用户主动收起后被旧活动信号弹回。
   */
  workbenchCollapsed: boolean;
  /**
   * 右栏当前的收起是不是**用户自己按的**。
   * 默认收起（初值 true）是产品默认值，不是用户意图——两者要分开，否则
   * 「任务开跑自动弹出右栏」和 #700 的「用户收起后不因活动信号自己弹回」二选一。
   * 只由 setWorkbenchCollapsed 写（它的调用点是用户点击）；syncWorkbenchForSession
   * 的强制收起不写本字段——那不是用户意图，任务活动照样能把右栏带出来。
   */
  workbenchCollapsedByUser: boolean;
  taskWorkbenchOpenSource: WorkbenchOpenSource | null;
  taskWorkbenchActivityActive: boolean;
  taskWorkbenchActivityKeysBySession: Record<string, string>;

  // 跨 panel 跳转高亮：能力来源跳转到 SkillsPanel 时设置
  // nonce 用于同一目标重复触发时强制 effect 重跑
  workbenchHighlight: WorkbenchHighlight | null;

  // Permission Request State
  pendingPermissionRequest: PermissionRequest | null;
  pendingPermissionSessionId: string | null; queuedPermissionRequests: Record<string, PermissionRequest[]>;
  resolvedPermissionRequests: Record<string, PermissionRequest[]>;
  sessionTaskProgress: Record<string, TaskProgressData | null | undefined>;
  sessionTaskComplete: Record<string, TaskCompleteData | null | undefined>;

  // /goal 自治模式运行态（per-session，SSE goal_* 事件驱动；状态条/生命周期消息读它）
  goalRuns: Record<string, GoalRunState | undefined>;

  // Model Config
  modelConfig: ModelConfig;

  // Workspace State
  workingDirectory: string | null;

  // Context Health State (上下文健康度)
  contextHealth: ContextHealthState | null;
  contextHealthCollapsed: boolean;

  // Actions
  setShowSettings: (show: boolean) => void;
  /** 带返回落点打开设置：用户关闭时回到 returnTo 页（深链落点不在设置页时退化为 openSettingsTab）。 */
  openSettingsWithReturn: (tab: SettingsTab, returnTo: SettingsReturnTo) => void;
  /** 用户关闭设置（X / Esc）：带返回落点时回该页；否则与 setShowSettings(false) 等价。 */
  closeSettings: () => void;
  setPendingRoleChatSeed: (seed: string | null) => void;
  openSettingsTab: (tab: SettingsTab) => void; // 打开设置并跳转到指定 Tab
  openMemorySettings: (focus?: Omit<SettingsMemoryFocus, 'nonce'>) => void;
  openCapabilitySettingsTarget: (focus: Omit<SettingsCapabilityFocus, 'nonce'>) => void;
  clearSettingsInitialTab: () => void; // 清除初始 Tab（设置页使用后调用）
  clearSettingsMemoryFocus: () => void;
  clearSettingsCapabilityFocus: () => void;
  requestComposerFocus: () => void;
  setShowPromptManager: (show: boolean) => void;
  setShowWorkspace: (show: boolean) => void;
  setTaskPanelTab: (tab: TaskPanelTab) => void;
  setShowAgentTeamPanel: (show: boolean) => void;
  setSelectedSwarmAgentId: (agentId: string | null) => void;
  /** 设置默认 agent；传 null 表示回到 builtin 'coder'（spawn 端处理）。 */
  setActiveAgentId: (agentId: string | null) => void;
  /** 会话切换/创建/清空时同步当前会话的 agent 选择；inheritCurrent=会话创建时继承 draft 期选择。 */
  syncActiveAgentForSession: (sessionId: string | null, opts?: { inheritCurrent?: boolean; metadata?: Record<string, unknown> }) => void;
  /**
   * 直接把 agent 绑到指定会话（E2「请 TA 来」）：先落盘 per-session map，再更新内存值。
   * 与 setActiveAgentId 的区别：不依赖 activeAgentSessionKey 已同步到该会话——
   * 新会话创建后 sync effect 尚未跑时也能正确绑定（sync 落地时从 map 读回同一值）。
   */
  bindAgentForSession: (sessionId: string, agentId: string) => void;
  /** 清理某会话持久化的 agent 选择；onlyIfAgentId = 仅当存量选择等于该值才清（防误清用户新选择）。 */
  clearActiveAgentForSession: (sessionId: string, opts?: { onlyIfAgentId?: string }) => void;
  setShowCapturePanel: (show: boolean) => void;
  setShowDesktopPanel: (show: boolean) => void;
  setShowLocalOpsPanel: (show: boolean) => void;
  setShowInAppValidation: (show: boolean) => void;
  setActiveInternalFeature: (id: string | null) => void;
  /** 打开「本机操作」页并切到指定 tab（默认桌面）。 */
  openLocalOpsPanel: (tab?: LocalOpsTab) => void;
  /** @deprecated 合并页兼容 shim：打开 = 本机操作页·桌面 tab；关闭 = 关页。 */
  setShowComputerUsePanel: (show: boolean) => void;
  /** @deprecated 合并页兼容 shim：打开 = 本机操作页·浏览器 tab；关闭 = 关页。 */
  setShowBrowserSurfacePanel: (show: boolean) => void;
  openProjectCollaborationPage: (projectId?: string | null) => void;
  closeProjectCollaborationPage: () => void;
  openProjectSpacePage: () => void;
  closeProjectSpacePage: () => void;
  setPendingInAppValidationRequest: (
    request: import('@shared/contract/browserInteraction').InAppValidationRequest | null,
  ) => void;
  setShowActivityPanel: (show: boolean) => void;
  setShowCapabilityHub: (show: boolean) => void;
  openCapabilityHub: (tab: CapabilityHubTab) => void;
  /** 回到会话区：关掉互斥表里所有二级页。侧栏选会话/新建任务时调用。 */
  closeSecondaryPages: () => void;
  setShowCronCenter: (show: boolean) => void;
  setShowTimeCapabilityCenter: (show: boolean) => void;
  setShowFileExplorer: (show: boolean) => void;
  setVoicePasteStatus: (status: 'idle' | 'recording' | 'transcribing' | 'processing') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setOptionalUpdateInfo: (info: UpdateInfo | null) => void;
  setShowOptionalUpdateModal: (show: boolean) => void;
  setLanguage: (language: Language) => void;
  setCloudUIStrings: (strings: CloudUIStrings | null) => void;
  setDisclosureLevel: (level: DisclosureLevel) => void;
  setDeveloperMode: (enabled: boolean) => void;
  setIsProcessing: (processing: boolean) => void;
  // 按会话设置处理状态
  setSessionProcessing: (sessionId: string, processing: boolean) => void;
  // 检查指定会话是否正在处理
  isSessionProcessing: (sessionId: string) => boolean;
  setTaskPlan: (plan: TaskPlan | null) => void;
  setFindings: (findings: Finding[]) => void;
  setErrors: (errors: ErrorRecord[]) => void;
  setShowDAGPanel: (show: boolean) => void;
  setShowLab: (show: boolean) => void;
  setShowLibraryPanel: (show: boolean) => void;
  openExpertRoleDetail: (roleId: string) => void;
  openPreview: (filePath: string, options?: OpenWorkbenchTabOptions) => void;
  openContentPreview: (input: ContentPreviewInput, options?: OpenWorkbenchTabOptions) => void;
  openWorkspacePreview: (options?: OpenWorkbenchTabOptions) => void;
  openLivePreview: (
    devServerUrl: string,
    devServerSessionId?: string,
    options?: OpenWorkbenchTabOptions,
  ) => void;
  /** V2-A: 打开/关闭 dev server launcher 模态 */
  openDevServerLauncher: () => void;
  closeDevServerLauncher: () => void;
  setSelectedElement: (tabId: string, element: LivePreviewSelectedElement | null) => void;
  jumpToFileLine: (filePath: string, line: number) => void;
  closePreview: () => void;
  closePreviewTab: (id: string) => void;
  setActivePreviewTab: (id: string) => void;

  // Unified workbench actions.
  syncWorkbenchForSession: (sessionId: string | null) => void;
  openWorkbenchTab: (id: WorkbenchTabId, options?: OpenWorkbenchTabOptions) => void;
  closeWorkbenchTab: (id: WorkbenchTabId) => void;
  setActiveWorkbenchTab: (id: WorkbenchTabId | null) => void;
  setWorkbenchCollapsed: (collapsed: boolean) => void;
  syncTaskWorkbenchForActivity: (sessionId: string | null, activityKey: string | null) => void;
  setWorkbenchHighlight: (highlight: Omit<WorkbenchHighlight, 'nonce'> | null) => void;
  updatePreviewTabContent: (id: string, content: string) => void;
  updatePreviewTabMode: (id: string, mode: 'preview' | 'source' | 'edit') => void;
  markPreviewTabLoaded: (id: string, savedContent: string) => void;
  markPreviewTabSaved: (id: string) => void;
  setPendingPermissionRequest: (request: PermissionRequest | null, sessionId?: string | null) => void;
  recordPermissionDecision: (request: PermissionRequest, decision: NonNullable<PermissionRequest['decision']>, sessionId?: string | null) => void;
  /** 另一个面（手机）先答：按 requestId 收卡，不进本机已决存证。 */
  dismissPermissionRequest: (requestId: string) => void;
  enqueuePermissionRequest: (
    sessionId: string,
    request: PermissionRequest,
    options?: { front?: boolean }
  ) => void;
  shiftQueuedPermissionRequest: (sessionId: string) => PermissionRequest | null;
  clearPermissionRequestsForSession: (sessionId: string) => void;
  setSessionTaskProgress: (sessionId: string, progress: TaskProgressData | null) => void;
  setSessionTaskComplete: (sessionId: string, complete: TaskCompleteData | null) => void;

  // /goal 运行态 actions
  setPendingProjectGoalChatSeed: (seed: PendingProjectGoalChatSeed | null) => void;
  startGoalRun: (sessionId: string, init: { goal: string; maxTurns?: number; tokenBudget?: number; wallClockBudgetMs?: number }) => void;
  updateGoalProgress: (sessionId: string, data: { turn?: number; maxTurns?: number; tokensUsed?: number; tokenBudget?: number; wallClockBudgetMs?: number }) => void;
  recordGoalGate: (sessionId: string, gate: { gate: number; pass: boolean; reason?: string; verificationCard?: GoalGateVerificationCard }) => void;
  finishGoalRun: (sessionId: string, status: 'met' | 'aborted', reason?: string, degraded?: boolean) => void;
  /** ③ session 内暂停/恢复：仅切换 running↔paused，不动 met/aborted（UI 态，配合后端 isPaused 循环挂起） */
  setGoalPaused: (sessionId: string, paused: boolean, pauseReason?: 'anti_spin') => void;
  clearGoalRun: (sessionId: string) => void;
  setModelConfig: (config: ModelConfig) => void;
  // clearChat 简化：只清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () => void;
  setWorkingDirectory: (dir: string | null) => void;
  setContextHealth: (health: ContextHealthState | null) => void;
  setContextHealthCollapsed: (collapsed: boolean) => void;
}
