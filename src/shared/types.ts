// ============================================================================
// Core Types for Code Agent
// ============================================================================

// ----------------------------------------------------------------------------
// Generation Types
// ----------------------------------------------------------------------------

export type GenerationId = 'gen1' | 'gen2' | 'gen3' | 'gen4' | 'gen5' | 'gen6' | 'gen7' | 'gen8';

export interface Generation {
  id: GenerationId;
  name: string;
  version: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  promptMetadata: {
    lineCount: number;
    toolCount: number;
    ruleCount: number;
  };
}

export interface GenerationDiff {
  added: string[];
  removed: string[];
  modified: Array<{
    line: number;
    before: string;
    after: string;
  }>;
}

// ----------------------------------------------------------------------------
// Model Types
// ----------------------------------------------------------------------------

export type ModelProvider =
  | 'deepseek'
  | 'claude'
  | 'openai'
  | 'groq'
  | 'local'
  | 'zhipu'      // 智谱 GLM
  | 'qwen'       // 通义千问
  | 'moonshot'   // Kimi
  | 'perplexity' // 联网搜索
  | 'openrouter'; // OpenRouter 中转（Gemini、Claude、GPT 等）

// 模型能力标签
export type ModelCapability = 'code' | 'vision' | 'fast' | 'reasoning' | 'gui' | 'general' | 'search';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  // 扩展配置
  capabilities?: ModelCapability[];
  computerUse?: boolean; // Claude Computer Use 支持
  useCloudProxy?: boolean; // 使用云端代理（管理员专用）
}

export interface ProviderConfig {
  id: ModelProvider;
  name: string;
  models: ModelInfo[];
  requiresApiKey: boolean;
  baseUrl?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  capabilities: ModelCapability[];
  maxTokens: number;
  supportsTool: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
}

// ----------------------------------------------------------------------------
// Cloud Agent Types
// ----------------------------------------------------------------------------

export type CloudAgentStatus = 'idle' | 'warming_up' | 'ready' | 'executing' | 'error';

export interface CloudAgentConfig {
  endpoint: string;
  apiKey?: string;
  timeout?: number;
  warmupOnInit?: boolean;
}

export interface CloudTaskRequest {
  id: string;
  type: 'browser' | 'compute' | 'skill';
  payload: {
    action?: string;
    url?: string;
    script?: string;
    skillName?: string;
    params?: Record<string, unknown>;
  };
  timeout?: number;
}

export interface CloudTaskResponse {
  id: string;
  status: 'success' | 'error' | 'timeout';
  result?: unknown;
  error?: string;
  duration?: number;
  screenshots?: string[]; // base64 encoded
}

// ----------------------------------------------------------------------------
// GUI Agent Types (Computer Use)
// ----------------------------------------------------------------------------

export interface ScreenCapture {
  width: number;
  height: number;
  data: string; // base64 encoded
  timestamp: number;
}

export interface ComputerAction {
  type: 'click' | 'type' | 'scroll' | 'screenshot' | 'key' | 'move';
  coordinate?: [number, number];
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface GUIAgentConfig {
  displayWidth: number;
  displayHeight: number;
  screenshotQuality?: number;
}

// ----------------------------------------------------------------------------
// Message Types
// ----------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

// 附件文件类别（用于精细化处理）
export type AttachmentCategory =
  | 'image'      // 图片：PNG, JPEG, GIF, WebP
  | 'pdf'        // PDF 文档
  | 'code'       // 代码文件：JS, TS, Python, etc.
  | 'text'       // 纯文本：TXT, MD
  | 'data'       // 数据文件：JSON, CSV, XML
  | 'document'   // 办公文档：DOCX, XLSX (需转换)
  | 'html'       // 网页：HTML
  | 'folder'     // 文件夹
  | 'other';     // 其他

// 附件类型
export interface MessageAttachment {
  id: string;
  type: 'image' | 'file';
  category: AttachmentCategory;  // 细粒度分类
  name: string;
  size: number;
  mimeType: string;
  // 图片: base64 数据 URL
  // 文件: 提取的文本内容
  data?: string;
  path?: string;
  // 图片预览 (缩略图)
  thumbnail?: string;
  // PDF 特有：页数
  pageCount?: number;
  // 代码特有：语言
  language?: string;
  // 文件夹特有：文件列表和统计
  files?: Array<{ path: string; content: string; size: number }>;
  folderStats?: { totalFiles: number; totalSize: number; byType: Record<string, number> };
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  // 多模态支持
  attachments?: MessageAttachment[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Result is attached by the UI when tool_call_end event is received
  result?: ToolResult;
  // 流式工具调用的临时属性
  _streaming?: boolean; // 标记是否正在流式接收中
  _argumentsRaw?: string; // 累积的原始参数字符串（用于增量解析）
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output?: string;
  error?: string;
  duration?: number;
}

// ----------------------------------------------------------------------------
// Tool Types
// ----------------------------------------------------------------------------

export type PermissionLevel = 'read' | 'write' | 'execute' | 'network';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  generations: GenerationId[];
  requiresPermission: boolean;
  permissionLevel: PermissionLevel;
}

export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchemaProperty;
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  workingDirectory: string;
  currentGeneration: Generation;
  modelConfig: ModelConfig;
  requestPermission: (request: PermissionRequest) => Promise<boolean>;
  emit: (event: string, data: unknown) => void;
}

// ----------------------------------------------------------------------------
// Permission Types
// ----------------------------------------------------------------------------

export interface PermissionRequest {
  id: string;
  type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command';
  tool: string;
  details: {
    path?: string;
    command?: string;
    url?: string;
    changes?: string;
  };
  reason?: string;
  timestamp: number;
}

export type PermissionResponse = 'allow' | 'allow_session' | 'deny';

// ----------------------------------------------------------------------------
// Session Types
// ----------------------------------------------------------------------------

export interface Session {
  id: string;
  title: string;
  generationId: GenerationId;
  modelConfig: ModelConfig;
  workingDirectory?: string;
  createdAt: number;
  updatedAt: number;
}

// ----------------------------------------------------------------------------
// Workspace Types
// ----------------------------------------------------------------------------

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface FileChange {
  path: string;
  type: 'created' | 'modified' | 'deleted';
  diff?: string;
  timestamp: number;
}

// ----------------------------------------------------------------------------
// Todo Types (for Gen 3+)
// ----------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

// ----------------------------------------------------------------------------
// Agent Types
// ----------------------------------------------------------------------------

export interface AgentConfig {
  generation: Generation;
  model: ModelConfig;
  workingDirectory: string;
}

export interface AgentState {
  isRunning: boolean;
  currentToolCalls: ToolCall[];
  pendingPermissions: PermissionRequest[];
  todos: TodoItem[];
}

export type AgentEvent =
  | { type: 'message'; data: Message }
  | { type: 'tool_call_start'; data: ToolCall & { _index?: number; turnId?: string } }
  | { type: 'tool_call_end'; data: ToolResult }
  | { type: 'permission_request'; data: PermissionRequest }
  | { type: 'error'; data: { message: string; code?: string } }
  | { type: 'stream_chunk'; data: { content: string | undefined; turnId?: string } }
  | { type: 'stream_tool_call_start'; data: { index?: number; id?: string; name?: string; turnId?: string } }
  | { type: 'stream_tool_call_delta'; data: { index?: number; name?: string; argumentsDelta?: string; turnId?: string } }
  | { type: 'todo_update'; data: TodoItem[] }
  | { type: 'notification'; data: { message: string } }
  | { type: 'agent_complete'; data: null }
  // Turn-based message events (行业最佳实践: Vercel AI SDK / LangGraph 模式)
  | { type: 'turn_start'; data: { turnId: string; iteration?: number } }
  | { type: 'turn_end'; data: { turnId: string } }
  // Model capability fallback event (能力补充)
  | { type: 'model_fallback'; data: { reason: string; from: string; to: string } }
  // API Key 缺失提示
  | { type: 'api_key_required'; data: { provider: string; capability: string; message: string } };

// ----------------------------------------------------------------------------
// Settings Types
// ----------------------------------------------------------------------------

export interface AppSettings {
  models: {
    default: string;
    defaultProvider?: ModelProvider;
    providers: Record<ModelProvider, {
      apiKey?: string;
      enabled: boolean;
      model?: string;
      baseUrl?: string;
      temperature?: number;
      maxTokens?: number;
    }>;
    // 按用途选择模型
    routing: {
      code: { provider: ModelProvider; model: string };
      vision: { provider: ModelProvider; model: string };
      fast: { provider: ModelProvider; model: string };
      gui: { provider: ModelProvider; model: string };
    };
  };
  generation: {
    default: GenerationId;
  };
  workspace: {
    defaultDirectory?: string;
    recentDirectories: string[];
  };
  permissions: {
    autoApprove: Record<PermissionLevel, boolean>;
    blockedCommands: string[];
    devModeAutoApprove: boolean; // Development mode: auto-approve all permissions
  };
  ui: {
    theme: 'light' | 'dark' | 'system';
    fontSize: number;
    showToolCalls: boolean;
    language: 'zh' | 'en';
    disclosureLevel?: 'simple' | 'standard' | 'advanced' | 'expert';
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
    enabled?: boolean;
  };
}

// ----------------------------------------------------------------------------
// Subagent Types (for Gen 3+)
// ----------------------------------------------------------------------------

export type SubagentType = 'explore' | 'bash' | 'plan' | 'code-review';

export interface SubagentConfig {
  id: SubagentType;
  name: string;
  description: string;
  availableTools: string[];
  systemPromptOverride?: string;
}

// ----------------------------------------------------------------------------
// Skill Types (for Gen 4)
// ----------------------------------------------------------------------------

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  args?: string[];
}

// ----------------------------------------------------------------------------
// Planning Types (for Gen 3+ Persistent Planning)
// ----------------------------------------------------------------------------

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export type TaskPhaseStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TaskStep {
  id: string;
  content: string;
  status: TaskStepStatus;
  activeForm?: string;
}

export interface TaskPhase {
  id: string;
  title: string;
  status: TaskPhaseStatus;
  steps: TaskStep[];
  notes?: string;
}

export interface TaskPlanMetadata {
  totalSteps: number;
  completedSteps: number;
  blockedSteps: number;
}

export interface TaskPlan {
  id: string;
  title: string;
  objective: string;
  phases: TaskPhase[];
  createdAt: number;
  updatedAt: number;
  metadata: TaskPlanMetadata;
}

export type FindingCategory = 'code' | 'architecture' | 'dependency' | 'issue' | 'insight';

export interface Finding {
  id: string;
  category: FindingCategory;
  title: string;
  content: string;
  source?: string;
  timestamp: number;
}

export interface ErrorRecord {
  id: string;
  toolName: string;
  message: string;
  params?: Record<string, unknown>;
  stack?: string;
  timestamp: number;
  count: number;
}

export interface PlanningState {
  plan: TaskPlan | null;
  findings: Finding[];
  errors: ErrorRecord[];
}

// ----------------------------------------------------------------------------
// User Question Types (for Gen 3+ ask_user_question)
// ----------------------------------------------------------------------------

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionRequest {
  id: string;
  questions: UserQuestion[];
  timestamp: number;
}

export interface UserQuestionResponse {
  requestId: string;
  answers: Record<string, string | string[]>; // question header -> selected option(s)
}

// ----------------------------------------------------------------------------
// Auth Types
// ----------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  username?: string;
  nickname?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  user: AuthUser | null;
  isLoading: boolean;
}

// ----------------------------------------------------------------------------
// Sync Types
// ----------------------------------------------------------------------------

export interface SyncStatus {
  isEnabled: boolean;
  isSyncing: boolean;
  lastSyncAt: number | null;
  pendingChanges: number;
  syncProgress?: {
    phase: 'pull' | 'push' | 'done';
    current: number;
    total: number;
  };
  error?: string;
}

export interface SyncConflict {
  id: string;
  table: string;
  localRecord: unknown;
  remoteRecord: unknown;
  conflictType: 'update' | 'delete';
}

// ----------------------------------------------------------------------------
// Device Types
// ----------------------------------------------------------------------------

export interface DeviceInfo {
  id: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  lastActiveAt: number;
  isCurrent: boolean;
}

// ----------------------------------------------------------------------------
// Update Types
// ----------------------------------------------------------------------------

export interface UpdateInfo {
  hasUpdate: boolean;
  /** 是否强制更新 - true 时弹出不可关闭的更新弹窗 */
  forceUpdate?: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  fileSize?: number;
  publishedAt?: string;
}

export interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}
