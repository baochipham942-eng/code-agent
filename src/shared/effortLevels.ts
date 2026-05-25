import type { EffortLevel } from './contract/agent';

export const SUPPORTED_AGENT_EFFORT_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly EffortLevel[];

export type SupportedAgentEffortLevel = typeof SUPPORTED_AGENT_EFFORT_LEVELS[number];

const SUPPORTED_AGENT_EFFORT_LEVEL_SET = new Set<string>(SUPPORTED_AGENT_EFFORT_LEVELS);

export function isSupportedAgentEffortLevel(level: unknown): level is SupportedAgentEffortLevel {
  return typeof level === 'string' && SUPPORTED_AGENT_EFFORT_LEVEL_SET.has(level);
}

export function normalizeAgentEffortLevel(
  level: EffortLevel | string | null | undefined,
  fallback: SupportedAgentEffortLevel = 'high',
): SupportedAgentEffortLevel {
  return isSupportedAgentEffortLevel(level) ? level : fallback;
}
