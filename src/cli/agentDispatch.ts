export type AgentDispatchInfo = { agent: string; task: string };

const AGENT_DISPATCH_TOOL_NAMES = new Set(['Task', 'task', 'spawn_agent', 'AgentSpawn']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function isAgentDispatchToolName(toolName: string): boolean {
  return AGENT_DISPATCH_TOOL_NAMES.has(toolName);
}

export function getAgentDispatchInfo(toolName: string, rawArgs: unknown): AgentDispatchInfo | null {
  if (!isAgentDispatchToolName(toolName) || !isRecord(rawArgs)) {
    return null;
  }

  return {
    agent: firstString(rawArgs, ['subagent_type', 'agent_type', 'role', 'agent']) ?? 'unknown',
    task: firstString(rawArgs, ['prompt', 'task', 'description']) ?? '',
  };
}
