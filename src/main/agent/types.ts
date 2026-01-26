// ============================================================================
// Agent Types - Enhanced type definitions for agent system
// ============================================================================

import type { PermissionMode, PermissionLevel } from '../permissions/modes';
import { AGENT_TIMEOUTS } from '../../shared/constants';

// ----------------------------------------------------------------------------
// Agent Definition Types
// ----------------------------------------------------------------------------

/**
 * Agent capability categories
 */
export type AgentCapability =
  | 'file_operations'    // Read, write, edit files
  | 'code_execution'     // Run bash commands
  | 'code_analysis'      // Analyze code, review
  | 'web_access'         // Fetch URLs, search
  | 'planning'           // Create and manage plans
  | 'delegation'         // Spawn sub-agents
  | 'memory'             // Store and retrieve memories
  | 'research';          // Deep research mode

/**
 * Agent priority level for task matching
 */
export type AgentPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * Agent execution mode
 */
export type AgentExecutionMode =
  | 'interactive'     // Requires user interaction
  | 'autonomous'      // Can run without user input
  | 'supervised';     // Runs autonomously but reports to parent

/**
 * Enhanced Agent Definition
 *
 * Defines the complete specification of an agent including:
 * - Identity and description for matching
 * - Capabilities and tools
 * - Permission requirements
 * - Execution constraints
 */
export interface AgentDefinition {
  /** Unique agent identifier */
  id: string;

  /** Human-readable agent name */
  name: string;

  /** Detailed description for auto-delegation matching */
  description: string;

  /** Keywords for task matching (e.g., "debug", "test", "review") */
  keywords: string[];

  /** Agent capabilities */
  capabilities: AgentCapability[];

  /** Tools this agent can use */
  availableTools: string[];

  /** Required generation level (1-8) */
  minGeneration: number;

  /** Maximum generation level (optional) */
  maxGeneration?: number;

  /** System prompt override */
  systemPrompt?: string;

  /** Default permission mode */
  defaultPermissionMode: PermissionMode;

  /** Maximum permission levels this agent can request */
  maxPermissionLevels: PermissionLevel[];

  /** Priority for matching */
  priority: AgentPriority;

  /** Execution mode */
  executionMode: AgentExecutionMode;

  /** Maximum iterations/turns */
  maxIterations: number;

  /** Timeout in milliseconds */
  timeout: number;

  /** Whether this agent can spawn sub-agents */
  canDelegate: boolean;

  /** Sub-agent types this agent can spawn */
  allowedSubagents?: string[];

  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Agent instance state
 */
export interface AgentInstance {
  /** Instance ID (unique per execution) */
  instanceId: string;

  /** Agent definition ID */
  agentId: string;

  /** Parent agent instance ID (if sub-agent) */
  parentInstanceId?: string;

  /** Session ID this agent belongs to */
  sessionId: string;

  /** Current state */
  state: AgentInstanceState;

  /** Creation timestamp */
  createdAt: number;

  /** Last activity timestamp */
  lastActivityAt: number;

  /** Current iteration */
  currentIteration: number;

  /** Effective permission mode */
  permissionMode: PermissionMode;

  /** Inherited permission constraints from parent */
  inheritedConstraints?: PermissionConstraints;

  /** Task being executed */
  task?: AgentTask;

  /** Results from completed sub-agents */
  subagentResults?: SubagentResult[];
}

/**
 * Agent instance state
 */
export type AgentInstanceState =
  | 'initializing'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user'
  | 'delegating'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Permission constraints inherited from parent
 */
export interface PermissionConstraints {
  /** Maximum permission mode allowed */
  maxMode: PermissionMode;

  /** Blocked permission levels */
  blockedLevels: PermissionLevel[];

  /** Allowed paths for file operations */
  allowedPaths?: string[];

  /** Blocked paths */
  blockedPaths?: string[];

  /** Allowed commands pattern */
  allowedCommands?: RegExp[];

  /** Blocked commands pattern */
  blockedCommands?: RegExp[];

  /** Network access allowed */
  allowNetwork: boolean;
}

/**
 * Task assigned to an agent
 */
export interface AgentTask {
  /** Task ID */
  id: string;

  /** Task description */
  description: string;

  /** Original user prompt (if any) */
  originalPrompt?: string;

  /** Expected output type */
  expectedOutput?: 'text' | 'code' | 'file' | 'report' | 'action';

  /** Task context */
  context?: Record<string, unknown>;

  /** Deadline timestamp (optional) */
  deadline?: number;
}

/**
 * Result from a sub-agent execution
 */
export interface SubagentResult {
  /** Sub-agent instance ID */
  instanceId: string;

  /** Agent definition ID */
  agentId: string;

  /** Task that was executed */
  task: AgentTask;

  /** Success status */
  success: boolean;

  /** Output/result */
  output: string;

  /** Error message if failed */
  error?: string;

  /** Tools used during execution */
  toolsUsed: string[];

  /** Number of iterations */
  iterations: number;

  /** Duration in milliseconds */
  duration: number;

  /** Timestamp of completion */
  completedAt: number;
}

// ----------------------------------------------------------------------------
// Built-in Agent Definitions
// ----------------------------------------------------------------------------

/**
 * Built-in agent types
 */
export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: 'explore',
    name: 'Codebase Explorer',
    description: 'Explores and understands codebase structure, finds files, searches code patterns',
    keywords: ['explore', 'find', 'search', 'locate', 'understand', 'structure', 'codebase'],
    capabilities: ['file_operations', 'code_analysis'],
    availableTools: ['read_file', 'glob', 'grep', 'list_directory'],
    minGeneration: 2,
    defaultPermissionMode: 'dontAsk',
    maxPermissionLevels: ['read'],
    priority: 'normal',
    executionMode: 'autonomous',
    maxIterations: 20,
    timeout: AGENT_TIMEOUTS.CODE_REVIEWER,
    canDelegate: false,
  },
  {
    id: 'bash',
    name: 'Command Runner',
    description: 'Executes shell commands, runs tests, builds projects',
    keywords: ['run', 'execute', 'test', 'build', 'compile', 'install', 'command', 'bash', 'shell'],
    capabilities: ['code_execution'],
    availableTools: ['bash'],
    minGeneration: 1,
    defaultPermissionMode: 'default',
    maxPermissionLevels: ['execute'],
    priority: 'normal',
    executionMode: 'supervised',
    maxIterations: 10,
    timeout: AGENT_TIMEOUTS.DOC_GENERATOR,
    canDelegate: false,
  },
  {
    id: 'plan',
    name: 'Planner',
    description: 'Creates implementation plans, breaks down complex tasks',
    keywords: ['plan', 'design', 'architecture', 'breakdown', 'strategy', 'roadmap'],
    capabilities: ['planning', 'code_analysis'],
    availableTools: ['read_file', 'glob', 'grep', 'todo_write'],
    minGeneration: 3,
    defaultPermissionMode: 'plan',
    maxPermissionLevels: ['read'],
    priority: 'high',
    executionMode: 'autonomous',
    maxIterations: 15,
    timeout: AGENT_TIMEOUTS.CODE_REVIEWER,
    canDelegate: false,
  },
  {
    id: 'code-review',
    name: 'Code Reviewer',
    description: 'Reviews code for bugs, security issues, best practices',
    keywords: ['review', 'check', 'analyze', 'lint', 'security', 'quality', 'bug'],
    capabilities: ['code_analysis', 'file_operations'],
    availableTools: ['read_file', 'glob', 'grep'],
    minGeneration: 3,
    defaultPermissionMode: 'dontAsk',
    maxPermissionLevels: ['read'],
    priority: 'normal',
    executionMode: 'autonomous',
    maxIterations: 20,
    timeout: AGENT_TIMEOUTS.CODE_REVIEWER,
    canDelegate: false,
  },
  {
    id: 'researcher',
    name: 'Deep Researcher',
    description: 'Performs in-depth research on topics, gathers information from multiple sources',
    keywords: ['research', 'investigate', 'learn', 'study', 'analyze', 'report'],
    capabilities: ['research', 'web_access'],
    availableTools: ['web_fetch', 'web_search'],
    minGeneration: 4,
    defaultPermissionMode: 'default',
    maxPermissionLevels: ['read', 'network'],
    priority: 'normal',
    executionMode: 'autonomous',
    maxIterations: 30,
    timeout: AGENT_TIMEOUTS.SECURITY_AUDITOR,
    canDelegate: true,
    allowedSubagents: ['explore'],
  },
  {
    id: 'orchestrator',
    name: 'Task Orchestrator',
    description: 'Coordinates complex multi-step tasks, delegates to appropriate sub-agents',
    keywords: ['orchestrate', 'coordinate', 'manage', 'complex', 'multi-step'],
    capabilities: ['delegation', 'planning'],
    availableTools: ['task', 'todo_write', 'ask_user_question'],
    minGeneration: 3,
    defaultPermissionMode: 'default',
    maxPermissionLevels: ['read', 'write', 'execute'],
    priority: 'critical',
    executionMode: 'interactive',
    maxIterations: 50,
    timeout: AGENT_TIMEOUTS.ARCHITECTURE_ANALYZER,
    canDelegate: true,
    allowedSubagents: ['explore', 'bash', 'plan', 'code-review', 'researcher'],
  },
];

// ----------------------------------------------------------------------------
// Agent Registry
// ----------------------------------------------------------------------------

/**
 * Agent Registry - Manages agent definitions
 */
export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();

  constructor() {
    // Register built-in agents
    for (const agent of BUILT_IN_AGENTS) {
      this.register(agent);
    }
  }

  /**
   * Register an agent definition
   */
  register(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * Get an agent by ID
   */
  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  /**
   * Get all registered agents
   */
  getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * Find agents by capability
   */
  findByCapability(capability: AgentCapability): AgentDefinition[] {
    return this.getAll().filter(a => a.capabilities.includes(capability));
  }

  /**
   * Find agents matching a keyword
   */
  findByKeyword(keyword: string): AgentDefinition[] {
    const lowerKeyword = keyword.toLowerCase();
    return this.getAll().filter(a =>
      a.keywords.some(k => k.toLowerCase().includes(lowerKeyword))
    );
  }

  /**
   * Find agents available for a given generation
   */
  findByGeneration(generation: number): AgentDefinition[] {
    return this.getAll().filter(a =>
      a.minGeneration <= generation &&
      (!a.maxGeneration || a.maxGeneration >= generation)
    );
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let agentRegistryInstance: AgentRegistry | null = null;

/**
 * Get or create agent registry instance
 */
export function getAgentRegistry(): AgentRegistry {
  if (!agentRegistryInstance) {
    agentRegistryInstance = new AgentRegistry();
  }
  return agentRegistryInstance;
}

/**
 * Reset agent registry instance (for testing)
 */
export function resetAgentRegistry(): void {
  agentRegistryInstance = null;
}
