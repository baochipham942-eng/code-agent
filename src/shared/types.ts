// ============================================================================
// Types Index - Re-export all types for backward compatibility
// ============================================================================
// NOTE: Types have been reorganized into src/shared/types/ directory
// This file re-exports everything to maintain backward compatibility
// New code should import from specific type files

// Core types
export * from './types/model';
export * from './types/message';
export * from './types/tool';
export * from './types/permission';

// Domain types
export * from './types/session';
export * from './types/workspace';
export * from './types/planning';
export * from './types/question';
export * from './types/elicitation';
export * from './types/agent';
export * from './types/skill';
export * from './types/agentSkill';

// Infrastructure types
export * from './types/auth';
export * from './types/sync';
export * from './types/device';
export * from './types/settings';
export * from './types/update';

// Cloud & GUI types
export * from './types/cloud';
export * from './types/gui';

// Memory types
export * from './types/memory';

// Desktop activity types
export * from './types/desktop';

// Checkpoint types (文件检查点)
export * from './types/checkpoint';

// Skill Repository types
export * from './types/skillRepository';

// Built-in Agent types (Gen7+)
export * from './types/builtInAgents';

// Workflow types (Gen7+)
export * from './types/workflow';

// Gen7 unified exports
export * from './types/gen7';

// Lab types (实验室)
export * from './types/lab';

// Channel types (多通道接入)
export * from './types/channel';

// Cron types (定时任务)
export * from './types/cron';

// ToolSearch types (工具延迟加载)
export * from './types/toolSearch';

// Swarm types (Agent Swarm 监控)
export * from './types/swarm';

// Diff types (E3: 变更追踪)
export * from './types/diff';

// Citation types (E1: 引用溯源)
export * from './types/citation';

// Confirmation types (E2: 确认门控)
export * from './types/confirmation';

// Capture types (浏览器采集)
export * from './types/capture';

// Error types
export * from './types/error';

// Application Service interface
export * from './types/appService';

// Trace types
export * from './types/trace';
