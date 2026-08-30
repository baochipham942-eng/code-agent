import * as yaml from 'js-yaml';
import { PROMPT_VERSION } from '@shared/constants/agent';
import {
  CONSUMED_COMPARE_FIELDS,
  UNCONSUMED_COMPARE_FIELDS,
  effectiveArmSignature,
  resolveEffectiveEvalCompareArm,
  type EvalCompareArm,
} from '@shared/contract/evaluation';
import { resolveProductionShape } from './productionShape';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`compare.candidate.${key} 必须是非空字符串。`);
  return value.trim();
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`compare.candidate.${key} 必须是布尔值。`);
  return value;
}

export function validateEvalCompareArm(value: unknown): EvalCompareArm {
  if (!isRecord(value)) throw new Error('compare.candidate 必须是对象。');
  const allowed = new Set(['name', ...CONSUMED_COMPARE_FIELDS, ...UNCONSUMED_COMPARE_FIELDS]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key as keyof EvalCompareArm));
  if (unknown.length > 0) throw new Error(`compare.candidate 包含未知字段：${unknown.join(', ')}`);
  const name = optionalString(value, 'name');
  if (!name) throw new Error('compare.candidate.name 必须是非空字符串。');
  const phantom = UNCONSUMED_COMPARE_FIELDS.filter((key) => value[key] !== undefined);
  if (phantom.length > 0) {
    throw new Error(`compare.candidate 包含执行链路不消费的字段：${phantom.join(', ')}`);
  }
  const harnessValue = value.harness;
  if (harnessValue !== undefined && !isRecord(harnessValue)) throw new Error('compare.candidate.harness 必须是对象。');
  const memoryValue = value.memory;
  if (memoryValue !== undefined && !isRecord(memoryValue)) throw new Error('compare.candidate.memory 必须是对象。');
  const reasoningEffort = optionalString(value, 'reasoningEffort');
  if (reasoningEffort && !['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
    throw new Error('compare.candidate.reasoningEffort 不受支持。');
  }
  if (value.skills !== undefined && (
    !Array.isArray(value.skills)
    || value.skills.some((item) => typeof item !== 'string' || item.trim() === '')
  )) throw new Error('compare.candidate.skills 必须是非空字符串数组。');
  return {
    name,
    model: optionalString(value, 'model'),
    provider: optionalString(value, 'provider'),
    systemPrompt: optionalString(value, 'systemPrompt'),
    harness: harnessValue ? {
      name: optionalString(harnessValue, 'name') ?? name,
      contextCompression: optionalBoolean(harnessValue, 'contextCompression'),
      compressionPipeline: optionalBoolean(harnessValue, 'compressionPipeline'),
      scaffoldProfile: optionalBoolean(harnessValue, 'scaffoldProfile'),
      thinkingInjection: optionalBoolean(harnessValue, 'thinkingInjection'),
      hooksEnabled: optionalBoolean(harnessValue, 'hooksEnabled'),
      toolMode: optionalString(harnessValue, 'toolMode') as 'all' | 'deferred' | undefined,
    } : undefined,
    memory: memoryValue ? {
      longTerm: optionalBoolean(memoryValue, 'longTerm'),
      routingModel: optionalString(memoryValue, 'routingModel'),
    } : undefined,
    reasoningEffort: reasoningEffort as EvalCompareArm['reasoningEffort'],
    skills: Array.isArray(value.skills) ? value.skills.map((item) => String(item).trim()) : undefined,
  };
}

export function buildProductionCompareArm(input: {
  model: string;
  provider: string;
  baselineName?: string;
}): EvalCompareArm {
  const shape = resolveProductionShape(input.model);
  return {
    name: input.baselineName?.trim() || `production-default@${PROMPT_VERSION}`,
    model: input.model,
    provider: input.provider,
    harness: shape.harness ?? undefined,
    memory: { longTerm: shape.memory },
    skills: shape.skills,
  };
}

export function assertEvalCompareDistinct(baseline: EvalCompareArm, candidate: EvalCompareArm): void {
  if (effectiveArmSignature(candidate, baseline) === effectiveArmSignature(baseline, baseline)) {
    throw new Error('两组一样，没法比');
  }
}

export function describeEvalCompareDiff(baseline: EvalCompareArm, candidate: EvalCompareArm): string[] {
  const before = resolveEffectiveEvalCompareArm(baseline, baseline);
  const after = resolveEffectiveEvalCompareArm(candidate, baseline);
  const labels: Record<(typeof CONSUMED_COMPARE_FIELDS)[number], string> = {
    model: 'model', provider: 'provider', systemPrompt: 'systemPrompt', harness: 'harness',
    memory: 'memory', reasoningEffort: 'reasoningEffort', skills: 'skill',
  };
  const value = (arm: typeof before, key: (typeof CONSUMED_COMPARE_FIELDS)[number]): unknown => {
    if (key !== 'harness') return arm[key];
    const effectiveHarness = { ...arm.harness };
    delete effectiveHarness.name;
    return effectiveHarness;
  };
  return CONSUMED_COMPARE_FIELDS.flatMap((key) => {
    const left = JSON.stringify(value(before, key));
    const right = JSON.stringify(value(after, key));
    if (left === right) return [];
    if (key === 'systemPrompt') {
      return [`systemPrompt: ${PROMPT_VERSION} → ${candidate.systemPrompt ? candidate.name : '相同'}`];
    }
    return [`${labels[key]}: ${left ?? '默认'} → ${right ?? '默认'}`];
  });
}

export function serializeEvalCompareArm(candidate: EvalCompareArm): string {
  return yaml.dump(candidate, { noRefs: true, lineWidth: 120, sortKeys: false });
}
