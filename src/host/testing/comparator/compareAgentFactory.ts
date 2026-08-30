import type { ModelProvider } from '../../../shared/contract';
import type { RequestPermissionResult } from '../../../shared/contract/permission';
import type { SessionType } from '../../../shared/contract/session';
import type { EvalRunStamp } from '../../../shared/contract/evaluation';
import type { PermissionRequestData } from '../../tools/types';
import type { DatabaseService } from '../../services/core/databaseService';
import type { TelemetryCollector } from '../../telemetry/telemetryCollector';
import { EVAL_AGENT_DEFAULTS, StandaloneAgentAdapter } from '../agentAdapter';
import type { CompareConfiguration, HarnessVariantConfig } from '../types';

export interface EffectiveCompareArm {
  name: string;
  model: string | null;
  provider: string | null;
  systemPrompt: string | null;
  harness: HarnessVariantConfig | null;
  memory: { longTerm: boolean; routingModel: string | null };
  reasoningEffort: CompareConfiguration['reasoningEffort'] | null;
}

export function resolveEffectiveCompareArm(
  config: CompareConfiguration,
  baseline: CompareConfiguration,
): EffectiveCompareArm {
  const sourceHarness = config.harness ?? baseline.harness;
  return {
    name: config.name,
    model: config.model ?? baseline.model ?? null,
    provider: config.provider ?? baseline.provider ?? null,
    systemPrompt: config.systemPrompt ?? baseline.systemPrompt ?? null,
    harness: sourceHarness ? { ...sourceHarness, name: config.name } : null,
    memory: {
      longTerm: config.memory?.longTerm ?? baseline.memory?.longTerm ?? false,
      routingModel: config.memory?.routingModel ?? baseline.memory?.routingModel ?? null,
    },
    reasoningEffort: config.reasoningEffort ?? baseline.reasoningEffort ?? null,
  };
}

export function buildCompareArmShape(
  config: CompareConfiguration,
  baseline: CompareConfiguration,
  swarm: boolean,
): EvalRunStamp['shape'] {
  const arm = resolveEffectiveCompareArm(config, baseline);
  return {
    skills: [...EVAL_AGENT_DEFAULTS.skills],
    memory: arm.memory.longTerm,
    swarm,
    harness: arm.harness,
  };
}

interface CompareAgentFactoryOptions {
  workingDirectory: string;
  apiKey: string;
  baseUrl?: string;
  requestPermission: (request: PermissionRequestData) => Promise<RequestPermissionResult>;
  sessionType?: SessionType;
  database?: DatabaseService;
  telemetryCollector?: TelemetryCollector;
}

/** The only constructor path for compare arms, keeping signature/stamp/runtime values aligned. */
export function createCompareAgent(
  config: CompareConfiguration,
  baseline: CompareConfiguration,
  options: CompareAgentFactoryOptions,
): StandaloneAgentAdapter {
  const arm = resolveEffectiveCompareArm(config, baseline);
  if (!arm.provider || !arm.model) {
    throw new Error(`[compare-arm-config] ${config.name} 缺少有效 provider/model。`);
  }
  return new StandaloneAgentAdapter({
    workingDirectory: options.workingDirectory,
    persistLongTermMemory: arm.memory.longTerm,
    memoryRoutingModel: arm.memory.routingModel ?? undefined,
    includeRecentConversations: EVAL_AGENT_DEFAULTS.includeRecentConversations,
    maxSystemPromptTokens: 12_000,
    skills: EVAL_AGENT_DEFAULTS.skills,
    includeClaudeLegacySkills: false,
    requestPermission: options.requestPermission,
    sessionType: options.sessionType ?? 'eval',
    database: options.database,
    telemetryCollector: options.telemetryCollector,
    ...(arm.reasoningEffort ? { inferenceOptions: { reasoningEffort: arm.reasoningEffort } } : {}),
    modelConfig: {
      provider: arm.provider as ModelProvider,
      model: arm.model,
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(arm.reasoningEffort
        ? { reasoningEffort: arm.reasoningEffort === 'xhigh' ? 'high' : arm.reasoningEffort }
        : {}),
    },
    ...(arm.systemPrompt ? { systemPromptOverride: arm.systemPrompt } : {}),
    ...(arm.harness ? { harness: arm.harness } : {}),
  });
}
