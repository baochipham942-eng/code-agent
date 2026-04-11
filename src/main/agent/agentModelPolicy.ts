import { AGENT_DEFAULT_MODEL, DEFAULT_MODELS } from '../../shared/constants/models';

export interface AgentModelSelection {
  provider: string;
  model: string;
  reason: string;
}

const AGENT_MODEL_DEFAULTS: Record<string, { provider: string; model: string; reason: string }> = {
  'Code Explorer': { ...AGENT_DEFAULT_MODEL, reason: '128k window, strong code comprehension' },
  'Code Reviewer': { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reason: 'transparent reasoning chain' },
  'Web Search': { provider: 'perplexity', model: 'sonar-pro', reason: 'native search integration' },
  'Document Reader': { provider: 'zhipu', model: DEFAULT_MODELS.quick, reason: 'cheap and fast' },
  'Technical Writer': { ...AGENT_DEFAULT_MODEL, reason: 'strong Chinese writing' },
  'Debugger': { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reason: 'complex reasoning' },
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
    return { provider: 'zhipu', model: DEFAULT_MODELS.quick, reason: 'budget constraint (<20% remaining)' };
  }

  // 3. Default lookup
  const def = AGENT_MODEL_DEFAULTS[agentType];
  if (def) return { ...def };

  // 4. Fallback for unknown types
  return { ...AGENT_DEFAULT_MODEL, reason: 'default model for unknown agent type' };
}
