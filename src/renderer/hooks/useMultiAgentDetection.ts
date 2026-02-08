// ============================================================================
// useMultiAgentDetection - Detect multi-agent collaboration in session
// ============================================================================

import { useMemo } from 'react';
import type { Message, ToolCall } from '@shared/types';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type CollaborationPattern = 'sequential' | 'parallel' | 'hierarchical' | 'single' | null;

export interface MultiAgentInfo {
  // Whether this is a multi-agent session
  isMultiAgent: boolean;
  // Number of agents detected
  agentCount: number;
  // List of active agent names
  activeAgents: string[];
  // Collaboration pattern
  pattern: CollaborationPattern;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Tool names that indicate multi-agent collaboration
const AGENT_SPAWN_TOOLS = ['spawn_agent', 'agent_create', 'create_agent'];
const AGENT_COMMUNICATION_TOOLS = ['agent_message', 'agent_send', 'send_to_agent'];
const TASK_DELEGATION_TOOLS = ['task', 'delegate_task', 'assign_task'];
const ORCHESTRATION_TOOLS = ['workflow_orchestrate', 'orchestrate', 'coordinate_agents'];

// All multi-agent related tools
const MULTI_AGENT_TOOLS = [
  ...AGENT_SPAWN_TOOLS,
  ...AGENT_COMMUNICATION_TOOLS,
  ...TASK_DELEGATION_TOOLS,
  ...ORCHESTRATION_TOOLS,
];

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Extract all tool calls from messages
 */
function extractToolCalls(messages: Message[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      toolCalls.push(...message.toolCalls);
    }
  }

  return toolCalls;
}

/**
 * Check if a tool call is related to multi-agent operations
 */
function isMultiAgentToolCall(toolCall: ToolCall): boolean {
  return MULTI_AGENT_TOOLS.includes(toolCall.name);
}

/**
 * Extract agent name from tool call arguments
 */
function extractAgentName(toolCall: ToolCall): string | null {
  const args = toolCall.arguments;

  // Common argument names for agent identification
  const nameFields = ['agent_name', 'agentName', 'name', 'agent', 'agent_id', 'agentId', 'target'];

  for (const field of nameFields) {
    if (args[field] && typeof args[field] === 'string') {
      return args[field] as string;
    }
  }

  // For task tool, check subagent_type (hybrid agent architecture) or assigned_to
  if (toolCall.name === 'task') {
    const subagentType = args['subagent_type'] as string | undefined;
    if (subagentType) return subagentType;
    const assignedTo = args['assigned_to'] as string | undefined;
    if (assignedTo) return assignedTo;
  }

  return null;
}

/**
 * Detect collaboration pattern from tool call sequence
 */
function detectPattern(toolCalls: ToolCall[]): CollaborationPattern {
  const agentToolCalls = toolCalls.filter(isMultiAgentToolCall);

  if (agentToolCalls.length === 0) {
    return 'single';
  }

  // Check for orchestration tools (hierarchical pattern)
  const hasOrchestration = agentToolCalls.some(tc =>
    ORCHESTRATION_TOOLS.includes(tc.name)
  );
  if (hasOrchestration) {
    return 'hierarchical';
  }

  // Check for spawn patterns
  const spawnCalls = agentToolCalls.filter(tc =>
    AGENT_SPAWN_TOOLS.includes(tc.name)
  );

  // Check for task delegation
  const taskCalls = agentToolCalls.filter(tc =>
    TASK_DELEGATION_TOOLS.includes(tc.name)
  );

  // Check for agent communication
  const messageCalls = agentToolCalls.filter(tc =>
    AGENT_COMMUNICATION_TOOLS.includes(tc.name)
  );

  // Detect parallel pattern: multiple spawn calls close together
  // or multiple task delegations without waiting for results
  if (spawnCalls.length >= 2) {
    // Check if spawns are in rapid succession (parallel)
    // This is a simplified heuristic - in reality we'd check timestamps
    const spawnIndices = spawnCalls.map(sc =>
      toolCalls.findIndex(tc => tc.id === sc.id)
    );

    // If spawn calls are consecutive or very close, it's parallel
    let isParallel = true;
    for (let i = 1; i < spawnIndices.length; i++) {
      if (spawnIndices[i] - spawnIndices[i - 1] > 3) {
        isParallel = false;
        break;
      }
    }

    if (isParallel) {
      return 'parallel';
    }
  }

  // Multiple task delegations suggest parallel execution
  if (taskCalls.length >= 2) {
    // Check if tasks target different agents
    const targetAgents = new Set<string>();
    for (const tc of taskCalls) {
      const agent = extractAgentName(tc);
      if (agent) {
        targetAgents.add(agent);
      }
    }

    if (targetAgents.size >= 2) {
      return 'parallel';
    }
  }

  // Sequential pattern: one agent at a time with message passing
  if (messageCalls.length > 0 || (spawnCalls.length >= 1 && taskCalls.length >= 1)) {
    return 'sequential';
  }

  // If we have any multi-agent activity but can't determine pattern
  if (agentToolCalls.length > 0) {
    return 'sequential';
  }

  return null;
}

/**
 * Extract unique agent names from tool calls
 */
function extractActiveAgents(toolCalls: ToolCall[]): string[] {
  const agents = new Set<string>();

  // Always include the main agent
  agents.add('main');

  for (const toolCall of toolCalls) {
    if (!isMultiAgentToolCall(toolCall)) {
      continue;
    }

    const agentName = extractAgentName(toolCall);
    if (agentName) {
      agents.add(agentName);
    }

    // For spawn_agent, also check for role or type
    if (AGENT_SPAWN_TOOLS.includes(toolCall.name)) {
      const role = toolCall.arguments['role'] as string | undefined;
      const type = toolCall.arguments['type'] as string | undefined;
      const agentType = toolCall.arguments['agent_type'] as string | undefined;

      if (role) agents.add(role);
      if (type) agents.add(type);
      if (agentType) agents.add(agentType);
    }
  }

  return Array.from(agents);
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/**
 * Hook to detect multi-agent collaboration patterns in a session.
 * Analyzes message history to identify:
 * - Whether multiple agents are involved
 * - How many agents are active
 * - Which agents are participating
 * - The collaboration pattern (sequential, parallel, hierarchical)
 *
 * @param messages - Array of messages from the current session
 * @returns MultiAgentInfo with detection results
 */
export function useMultiAgentDetection(messages: Message[]): MultiAgentInfo {
  return useMemo(() => {
    // Handle empty or undefined messages
    if (!messages || messages.length === 0) {
      return {
        isMultiAgent: false,
        agentCount: 1,
        activeAgents: ['main'],
        pattern: 'single',
      };
    }

    // Extract all tool calls from messages
    const toolCalls = extractToolCalls(messages);

    // Check for multi-agent tool usage
    const hasMultiAgentTools = toolCalls.some(isMultiAgentToolCall);

    // Extract active agents
    const activeAgents = extractActiveAgents(toolCalls);

    // Detect collaboration pattern
    const pattern = detectPattern(toolCalls);

    // Determine if this is a multi-agent session
    const isMultiAgent = hasMultiAgentTools || activeAgents.length > 1;

    return {
      isMultiAgent,
      agentCount: activeAgents.length,
      activeAgents,
      pattern: isMultiAgent ? pattern : 'single',
    };
  }, [messages]);
}

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

/**
 * Check if the current session has parallel agent execution
 */
export function useIsParallelExecution(messages: Message[]): boolean {
  const { pattern } = useMultiAgentDetection(messages);
  return pattern === 'parallel';
}

/**
 * Check if the current session has hierarchical agent orchestration
 */
export function useIsHierarchicalOrchestration(messages: Message[]): boolean {
  const { pattern } = useMultiAgentDetection(messages);
  return pattern === 'hierarchical';
}

/**
 * Get the count of active agents in the session
 */
export function useAgentCount(messages: Message[]): number {
  const { agentCount } = useMultiAgentDetection(messages);
  return agentCount;
}
