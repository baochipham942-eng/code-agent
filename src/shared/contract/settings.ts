// ============================================================================
// Settings Types
// ============================================================================

import type { ModelProvider } from './model';
import type { ModelCapability } from './model';
import type { PermissionLevel } from './tool';
import type { ContextCompressionConfig } from './contextHealth';

export interface ModelEntrySettings {
  enabled?: boolean;
  label?: string;
  capabilities?: ModelCapability[];
  maxTokens?: number;
  supportsTool?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  discoveredAt?: number;
}

export interface ModelProviderSettings {
  apiKey?: string;
  enabled: boolean;
  model?: string;
  baseUrl?: string;
  displayName?: string;
  temperature?: number;
  maxTokens?: number;
  models?: Record<string, ModelEntrySettings>;
}

export interface AppSettings {
  models: {
    default: string;
    defaultProvider?: ModelProvider;
    providers: Record<ModelProvider, ModelProviderSettings>;
    // 按用途选择模型
    routing: {
      code: { provider: ModelProvider; model: string };
      vision: { provider: ModelProvider; model: string };
      fast: { provider: ModelProvider; model: string };
      gui: { provider: ModelProvider; model: string };
    };
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
  generation: {
    default?: string;
  };
  workspace: {
    defaultDirectory?: string;
    recentDirectories: string[];
  };
  permissions: {
    autoApprove: Record<PermissionLevel, boolean>;
    blockedCommands: string[];
    devModeAutoApprove: boolean; // Development mode: auto-approve all permissions
    /** 权限模式，持久化存储（重启/重装后恢复） */
    permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate';
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
    enabled?: boolean;
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
}
