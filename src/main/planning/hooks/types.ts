// ============================================================================
// Hooks Type Definitions - Dual-channel architecture types
// ============================================================================

import type { HookContext, HookResult } from '../types';

// ----------------------------------------------------------------------------
// Hook Matcher Types
// ----------------------------------------------------------------------------

/**
 * Matcher function to determine if a hook should be triggered
 * Returns true if the hook should run for this context
 */
export type HookMatcher = (context: HookContext) => boolean;

/**
 * Pre-built matcher factories for common patterns
 */
export interface MatcherFactory {
  /** Match specific tool names */
  tools: (...names: string[]) => HookMatcher;
  /** Match tool categories */
  category: (category: ToolCategory) => HookMatcher;
  /** Match any context (always triggers) */
  any: () => HookMatcher;
  /** Combine matchers with AND logic */
  and: (...matchers: HookMatcher[]) => HookMatcher;
  /** Combine matchers with OR logic */
  or: (...matchers: HookMatcher[]) => HookMatcher;
  /** Negate a matcher */
  not: (matcher: HookMatcher) => HookMatcher;
}

// ----------------------------------------------------------------------------
// Tool Categories
// ----------------------------------------------------------------------------

export type ToolCategory =
  | 'critical' // Tools that modify state: bash, write_file, edit_file
  | 'view' // Read-only tools: read_file, glob, grep, list_directory
  | 'write' // File write tools: write_file, edit_file
  | 'planning' // Planning tools: plan_read, plan_update, todo_write
  | 'communication' // User interaction: ask_user_question
  | 'external'; // External services: web_fetch, mcp

/**
 * Tool category definitions
 */
export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
  critical: ['bash', 'write_file', 'edit_file'],
  view: ['read_file', 'glob', 'grep', 'list_directory', 'web_fetch'],
  write: ['write_file', 'edit_file'],
  planning: ['plan_read', 'plan_update', 'plan_create', 'todo_write'],
  communication: ['ask_user_question'],
  external: ['web_fetch', 'mcp', 'mcp_list_tools', 'mcp_read_resource'],
};

// ----------------------------------------------------------------------------
// Observer Hook Types (Passive - observe and record, never block)
// ----------------------------------------------------------------------------

/**
 * Observer hook - runs passively, cannot block execution
 * Used for: logging, metrics, audit trails, statistics
 */
export interface ObserverHook {
  /** Unique identifier for this hook */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this hook observes */
  description?: string;
  /** When this hook should trigger */
  matcher: HookMatcher;
  /** The observation handler - cannot return blocking decisions */
  observe: (context: HookContext) => void | Promise<void>;
}

// ----------------------------------------------------------------------------
// Decision Hook Types (Active - can block or inject context)
// ----------------------------------------------------------------------------

/**
 * Decision returned by a decision hook
 */
export interface HookDecision {
  /** Whether to continue with the action */
  allow: boolean;
  /** Context to inject into the prompt */
  injectContext?: string;
  /** Notification to show to user (non-blocking) */
  notification?: string;
  /** Reason for the decision (for logging) */
  reason?: string;
}

/**
 * Decision hook - can block execution or inject context
 * Used for: permission checks, rate limiting, error prevention, guardrails
 */
export interface DecisionHook {
  /** Unique identifier for this hook */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this hook decides */
  description?: string;
  /** Priority (higher runs first, default 0) */
  priority?: number;
  /** When this hook should trigger */
  matcher: HookMatcher;
  /** The decision handler - returns whether to allow the action */
  decide: (context: HookContext) => HookDecision | Promise<HookDecision>;
}

// ----------------------------------------------------------------------------
// Hook Point Types
// ----------------------------------------------------------------------------

/**
 * Standard hook points in the execution lifecycle
 */
export type HookPoint =
  | 'session_start' // Start of a new session
  | 'pre_tool_use' // Before a tool is executed
  | 'post_tool_use' // After a tool is executed
  | 'on_stop' // When agent tries to stop
  | 'on_error'; // When an error occurs

/**
 * Hook registration for a specific hook point
 */
export interface HookRegistration<T extends ObserverHook | DecisionHook> {
  point: HookPoint;
  hook: T;
}

// ----------------------------------------------------------------------------
// Hook Engine Configuration
// ----------------------------------------------------------------------------

/**
 * Configuration for the dual-channel hooks engine
 */
export interface DualChannelConfig {
  /** Enable/disable observer hooks */
  enableObservers: boolean;
  /** Enable/disable decision hooks */
  enableDecisions: boolean;
  /** Run observers in parallel (default: true) */
  parallelObservers: boolean;
  /** Maximum time for observer execution before timeout (ms) */
  observerTimeout: number;
  /** Maximum time for decision execution before timeout (ms) */
  decisionTimeout: number;
}

/**
 * Default configuration
 */
export const DEFAULT_DUAL_CHANNEL_CONFIG: DualChannelConfig = {
  enableObservers: true,
  enableDecisions: true,
  parallelObservers: true,
  observerTimeout: 5000,
  decisionTimeout: 10000,
};

// ----------------------------------------------------------------------------
// Aggregated Hook Result
// ----------------------------------------------------------------------------

/**
 * Result from running all hooks at a hook point
 */
export interface AggregatedHookResult extends HookResult {
  /** Individual decisions from decision hooks */
  decisions: Array<{
    hookId: string;
    decision: HookDecision;
  }>;
  /** Any errors from observer hooks (non-fatal) */
  observerErrors: Array<{
    hookId: string;
    error: Error;
  }>;
}
