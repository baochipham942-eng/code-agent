// ============================================================================
// Settings Types
// ============================================================================

import type { GenerationId } from './generation';
import type { ModelProvider } from './model';
import type { PermissionLevel } from './tool';

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
    /** 权限模式，持久化存储（重启/重装后恢复） */
    permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate';
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
}
