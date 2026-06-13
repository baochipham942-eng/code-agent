// ============================================================================
// Types Index - Re-export all types for backward compatibility
// ============================================================================

// Core types
export * from './model';
export * from './modelDecision';
export * from './message';
export * from './appshot';
export * from './tool';
export * from './permission';

// Domain types
export * from './session';
export * from './project';
export * from './workspace';
export * from './workspacePreview';
export * from './designBrief';
export * from './planning';
export * from './question';
export * from './elicitation';
export * from './agent';
export * from './agentEngine';
export * from './skill';
export * from './agentSkill';
export * from './skillRepository';
export * from './mcpCatalog';

// Infrastructure types
export * from './auth';
export * from './admin';
export * from './sync';
export * from './device';
export * from './settings';
export * from './configScope';
// IReadConfigService / ServiceApiKey 直接从 './configService' 子路径导入
// （barrel + isolatedModules 下 type-only re-export 偶尔解析失败）
export * from './update';
export * from './shellCapabilities';

// GUI types
export * from './gui';

// Memory types
export * from './memory';

// Built-in Agent types
export * from './builtInAgents';

// Agent Registry (custom .md agents — builtin + user + project)
export * from './agentRegistry';

// Role Assets (持久化角色资产 — 角色面板)
export * from './roleAssets';

// Workflow types
export * from './workflow';

// Multi-agent unified exports (convenience re-export)
export * from './multiAgent';

// Lab types (实验室)
export * from './lab';

// Channel types (多通道接入)
export * from './channel';

// Cron types (定时任务)
export * from './cron';

// Checkpoint types (文件检查点)
export * from './checkpoint';

// ToolSearch types (工具延迟加载)
export * from './toolSearch';
export * from './artifactBlob';
export * from './deliverable';

// Swarm types (Agent Swarm 监控)
export * from './swarm';

// Diff types (E3: 变更追踪)
export * from './diff';

// Citation types (E1: 引用溯源)
export * from './citation';

// Confirmation types (E2: 确认门控)
export * from './confirmation';

// Capture types (浏览器采集)
export * from './capture';

// Desktop activity types (原生桌面采集)
export * from './desktop';
export * from './activityProvider';
export * from './activityContext';

// Error types (ErrorCode, ErrorSeverity, SerializedError)
export * from './error';

// Application Service interface (IPC 层窄接口)
export * from './appService';

// Trace types (Turn-based trace view)
export * from './trace';
export * from './turnTimeline';
export * from './sessionWorkspace';
export * from './workbenchPreset';
export * from './reviewQueue';
export * from './productClosure';
export * from './completionSummary';
export * from './handoff';
export * from './persistence';

// Conversation envelope types (chat-native workbench context)
export * from './conversationEnvelope';
export * from './workbenchTools';

// Decision Trace types (Security decision chain transparency)
export * from './decisionTrace';

// Extension types (Unified plugin/skill management)
export * from './extension';

// Capability Center types
export * from './capability';
export * from './controlPlane';

// Agent History types (completed agent run records)
export * from './agentHistory';
