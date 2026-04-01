export interface AgentModelSelection {
  provider: string;
  model: string;
  reason: string;
}

const AGENT_MODEL_DEFAULTS: Record<string, { provider: string; model: string; reason: string }> = {
  'Code Explorer': { provider: 'moonshot', model: 'kimi-k2.5', reason: '128k window, strong code comprehension' },
  'Code Reviewer': { provider: 'deepseek', model: 'deepseek-reasoner', reason: 'transparent reasoning chain' },
  'Web Search': { provider: 'perplexity', model: 'sonar-pro', reason: 'native search integration' },
  'Document Reader': { provider: 'zhipu', model: 'glm-4-flash', reason: 'cheap and fast' },
  'Technical Writer': { provider: 'moonshot', model: 'kimi-k2.5', reason: 'strong Chinese writing' },
  'Debugger': { provider: 'deepseek', model: 'deepseek-reasoner', reason: 'complex reasoning' },
};

export function selectAgentModel(
  agentType: string,
  options?: {
    budgetRemaining?: number;
    userOverride?: Record<string, { provider: string; model: string }>;
  },
): AgentModelSelection {
  // 1. User override takes precedence
  if (options?.userOverride?.[agentType]) {
    const o = options.userOverride[agentType];
    return { ...o, reason: 'user override' };
  }

  // 2. Low budget → cheapest model
  if (options?.budgetRemaining !== undefined && options.budgetRemaining < 0.2) {
    return { provider: 'zhipu', model: 'glm-4-flash', reason: 'budget constraint (<20% remaining)' };
  }

  // 3. Default lookup
  const def = AGENT_MODEL_DEFAULTS[agentType];
  if (def) return { ...def };

  // 4. Fallback for unknown types
  return { provider: 'moonshot', model: 'kimi-k2.5', reason: 'default model for unknown agent type' };
}
