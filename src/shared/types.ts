// ============================================================================
// Types Index - Re-export all types for backward compatibility
// ============================================================================
// NOTE: Types have been reorganized into src/shared/types/ directory
// This file re-exports everything to maintain backward compatibility
// New code should import from specific type files

// Core types
export * from './types/generation';
export * from './types/model';
export * from './types/message';
export * from './types/tool';
export * from './types/permission';

// Domain types
export * from './types/session';
export * from './types/workspace';
export * from './types/planning';
export * from './types/question';
export * from './types/agent';
export * from './types/skill';

// Infrastructure types
export * from './types/auth';
export * from './types/sync';
export * from './types/device';
export * from './types/settings';
export * from './types/update';

// Cloud & GUI types
export * from './types/cloud';
export * from './types/gui';
