// ============================================================================
// Types Index - Re-export all types for backward compatibility
// ============================================================================
// NOTE: Types have been reorganized into src/shared/contract/ directory
// This file re-exports everything to maintain backward compatibility
// New code should import from specific type files

// Core types
export * from './contract/model';
export * from './contract/message';
export * from './contract/tool';
export * from './contract/permission';

// Domain types
export * from './contract/session';
export * from './contract/workspace';
export * from './contract/planning';
export * from './contract/question';
export * from './contract/elicitation';
export * from './contract/agent';
export * from './contract/skill';
export * from './contract/agentSkill';

// Infrastructure types
export * from './contract/auth';
export * from './contract/sync';
export * from './contract/device';
export * from './contract/settings';
export * from './contract/update';

// Cloud & GUI types
export * from './contract/cloud';
export * from './contract/gui';

// Memory types
export * from './contract/memory';

// Desktop activity types
export * from './contract/desktop';
export * from './contract/activityProvider';
export * from './contract/activityContext';

// Checkpoint types (文件检查点)
export * from './contract/checkpoint';

// Skill Repository types
export * from './contract/skillRepository';

// Built-in Agent types (Gen7+)
export * from './contract/builtInAgents';

// Workflow types (Gen7+)
export * from './contract/workflow';

// Gen7 unified exports
export * from './contract/gen7';

// Lab types (实验室)
export * from './contract/lab';

// Channel types (多通道接入)
export * from './contract/channel';

// Cron types (定时任务)
export * from './contract/cron';

// ToolSearch types (工具延迟加载)
export * from './contract/toolSearch';

// Swarm types (Agent Swarm 监控)
export * from './contract/swarm';

// Diff types (E3: 变更追踪)
export * from './contract/diff';

// Citation types (E1: 引用溯源)
export * from './contract/citation';

// Confirmation types (E2: 确认门控)
export * from './contract/confirmation';

// Capture types (浏览器采集)
export * from './contract/capture';

// Error types
export * from './contract/error';

// Application Service interface
export * from './contract/appService';

// Trace types
export * from './contract/trace';

// Decision Trace types (Security decision chain transparency)
export * from './contract/decisionTrace';
