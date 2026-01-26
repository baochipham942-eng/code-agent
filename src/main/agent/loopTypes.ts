// ============================================================================
// Agent Loop Types - Type definitions for AgentLoop internal use
// ============================================================================

import type {
  Generation,
  ModelConfig,
  Message,
  MessageAttachment,
  ToolCall,
  ToolResult,
  AgentEvent,
} from '../../shared/types';
import type { StructuredOutputConfig } from './structuredOutput';
import type { ToolRegistry } from '../tools/toolRegistry';
import type { ToolExecutor } from '../tools/toolExecutor';
import type { PlanningService } from '../planning';
import type { HookManager } from '../hooks';

// ----------------------------------------------------------------------------
// Configuration Types
// ----------------------------------------------------------------------------

/**
 * Agent Loop 配置
 */
export interface AgentLoopConfig {
  generation: Generation;
  modelConfig: ModelConfig;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  planningService?: PlanningService;
  enableHooks?: boolean;
  hookManager?: HookManager;
  sessionId?: string;
  userId?: string;
  workingDirectory: string;
  isDefaultWorkingDirectory?: boolean;
  structuredOutput?: StructuredOutputConfig;
}

// ----------------------------------------------------------------------------
// Model Response Types
// ----------------------------------------------------------------------------

/**
 * Model inference response
 */
export interface ModelResponse {
  type: 'text' | 'tool_use';
  content?: string;
  toolCalls?: ToolCall[];
  truncated?: boolean;
  finishReason?: string;
}

/**
 * Multimodal message content (matches ModelRouter)
 */
export interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Model message format
 */
export interface ModelMessage {
  role: string;
  content: string | MessageContent[];
}

// ----------------------------------------------------------------------------
// Tool Execution Types
// ----------------------------------------------------------------------------

/**
 * Tool execution context passed to ToolExecutor
 */
export interface ToolExecutionContext {
  generation: Generation;
  planningService?: PlanningService;
  modelConfig: ModelConfig;
  setPlanMode: (active: boolean) => void;
  isPlanMode: () => boolean;
  emitEvent: (event: string, data: unknown) => void;
  sessionId: string;
  preApprovedTools: Set<string>;
  currentAttachments: MessageAttachment[];
}

/**
 * Result of tool call classification
 */
export interface ToolClassification {
  parallelGroup: Array<{ index: number; toolCall: ToolCall }>;
  sequentialGroup: Array<{ index: number; toolCall: ToolCall }>;
}

/**
 * Circuit breaker state
 */
export interface CircuitBreakerState {
  consecutiveFailures: number;
  isTripped: boolean;
  lastTripTime?: number;
}

// ----------------------------------------------------------------------------
// Anti-Pattern Detection Types
// ----------------------------------------------------------------------------

/**
 * Tool failure tracking entry
 */
export interface ToolFailureEntry {
  count: number;
  lastError: string;
}

/**
 * Failed tool call pattern match result
 */
export interface FailedToolCallMatch {
  toolName: string;
  args?: string;
}

/**
 * Anti-pattern detection state
 */
export interface AntiPatternState {
  consecutiveReadOps: number;
  hasWrittenFile: boolean;
  toolFailureTracker: Map<string, ToolFailureEntry>;
  duplicateCallTracker: Map<string, number>;
}

// ----------------------------------------------------------------------------
// Progress Tracking Types
// ----------------------------------------------------------------------------

/**
 * Turn-based progress tracking state
 */
export interface TurnProgressState {
  turnId: string;
  startTime: number;
  toolsUsed: string[];
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * Tools that are safe to execute in parallel (stateless, read-only)
 */
export const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_directory',
  'web_fetch',
  'web_search',
  'memory_search',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_get_status',
]);

/**
 * Tools that modify state and must be executed sequentially
 */
export const SEQUENTIAL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'bash',
  'memory_store',
  'ask_user_question',
  'todo_write',
  'task',
  'spawn_agent',
]);

/**
 * Maximum number of tools to execute in parallel
 */
export const MAX_PARALLEL_TOOLS = 4;

/**
 * Read-only tools for anti-pattern tracking
 */
export const READ_ONLY_TOOLS = ['read_file', 'glob', 'grep', 'list_directory', 'web_fetch'];

/**
 * Write tools for anti-pattern tracking
 */
export const WRITE_TOOLS = ['write_file', 'edit_file'];

/**
 * Large binary data fields to filter from tool results
 */
export const LARGE_DATA_FIELDS = [
  'imageBase64',
  'screenshotData',
  'pdfImages',
  'audioData',
  'videoData',
  'base64',
  'data',
];

/**
 * Large data threshold in bytes
 */
export const LARGE_DATA_THRESHOLD = 10000;
