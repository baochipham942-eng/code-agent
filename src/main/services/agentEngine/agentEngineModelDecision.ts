import type {
  AgentEngineDescriptor,
  AgentEngineFailureDiagnostics,
  ExternalAgentEngineKind,
} from '../../../shared/contract/agentEngine';
import type { ModelDecisionEventData, ModelToolPolicy } from '../../../shared/contract/modelDecision';

function isExternalEngineKind(kind: string): kind is ExternalAgentEngineKind {
  return kind === 'codex_cli' || kind === 'claude_code';
}

function resolveToolPolicy(descriptor: AgentEngineDescriptor): ModelToolPolicy {
  return descriptor.reliability?.toolSupport === 'none' ? 'disabled-by-model' : 'runtime-checked';
}

export function buildAgentEngineModelDecision(
  descriptor: AgentEngineDescriptor,
  model?: string | null,
  timestamp: number = Date.now(),
  failure?: AgentEngineFailureDiagnostics,
): ModelDecisionEventData | undefined {
  if (!isExternalEngineKind(descriptor.kind)) return undefined;

  const selectedModel = model?.trim() || 'default';
  const label = descriptor.label || descriptor.kind;
  return {
    requestedProvider: descriptor.kind,
    requestedModel: selectedModel,
    resolvedProvider: descriptor.kind,
    resolvedModel: selectedModel,
    role: null,
    reason: 'user-selected',
    billingMode: 'unknown',
    fallbackFrom: null,
    taskClass: 'coding',
    costPolicy: 'user-locked',
    speedPolicy: 'normal',
    toolPolicy: resolveToolPolicy(descriptor),
    capabilityNeeds: ['code', 'tool-use'],
    strategySummary: failure
      ? `${label} 使用 ${selectedModel} 执行失败：${failure.reason}。${failure.suggestion}`
      : `${label} 使用 ${selectedModel} 执行本轮任务；CLI、登录态、quota、stream 和工具链路会影响输出可靠性。`,
    externalEngine: {
      kind: descriptor.kind,
      label,
      ...(selectedModel ? { model: selectedModel } : {}),
      installState: descriptor.installState,
      runtimeState: descriptor.runtimeState,
      executable: descriptor.executable,
      capabilities: descriptor.capabilities ?? [],
      ...(descriptor.reliability ? { reliability: descriptor.reliability } : {}),
      ...(failure ? { failure } : {}),
      ...(descriptor.command ? { command: descriptor.command } : {}),
      ...(descriptor.version ? { version: descriptor.version } : {}),
    },
    timestamp,
  };
}
