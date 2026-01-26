// ============================================================================
// Types Index - Re-export all types for backward compatibility
// ============================================================================

// Core types
export * from './generation';
export * from './model';
export * from './message';
export * from './tool';
export * from './permission';

// Domain types
export * from './session';
export * from './workspace';
export * from './planning';
export * from './question';
export * from './agent';
export * from './skill';
export * from './agentSkill';
export * from './skillRepository';

// Infrastructure types
export * from './auth';
export * from './sync';
export * from './device';
export * from './settings';
export * from './update';

// Cloud & GUI types
export * from './cloud';
export * from './gui';

// Memory types
export * from './memory';

// Built-in Agent types (Gen7+)
export * from './builtInAgents';

// Workflow types (Gen7+)
export * from './workflow';

// Gen7 unified exports (convenience re-export)
// Users can import from '@shared/types/gen7' for all Gen7 types in one place
export * from './gen7';

// Lab types (实验室)
export * from './lab';
