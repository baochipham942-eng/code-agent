export const MODEL_DEFAULT_ONLY_TEMPERATURE = 1;

const DEFAULT_ONLY_TEMPERATURE_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.5-pro',
]);

export type ModelTemperatureConstraint =
  | { kind: 'custom' }
  | { kind: 'default_only'; temperature: typeof MODEL_DEFAULT_ONLY_TEMPERATURE };

export interface ModelTemperatureControl {
  locked: boolean;
  temperature?: number;
  reason?: 'default_only';
}

export function normalizeSamplingModelId(model?: string | null): string {
  if (!model) return '';
  const normalized = model.trim().toLowerCase();
  if (!normalized) return '';
  const pathParts = normalized.split('/').filter(Boolean);
  return pathParts[pathParts.length - 1] ?? normalized;
}

export function getModelTemperatureConstraint(model?: string | null): ModelTemperatureConstraint {
  const modelId = normalizeSamplingModelId(model);
  if (DEFAULT_ONLY_TEMPERATURE_MODELS.has(modelId)) {
    return { kind: 'default_only', temperature: MODEL_DEFAULT_ONLY_TEMPERATURE };
  }
  return { kind: 'custom' };
}

export function requiresDefaultOnlyTemperature(model?: string | null): boolean {
  return getModelTemperatureConstraint(model).kind === 'default_only';
}

export function resolveModelRequestTemperature(model: string | undefined, temperature: number | undefined): number | undefined {
  const constraint = getModelTemperatureConstraint(model);
  if (constraint.kind === 'default_only') {
    return constraint.temperature;
  }
  return typeof temperature === 'number' && Number.isFinite(temperature) ? temperature : undefined;
}

export function getModelTemperatureControl(model?: string | null): ModelTemperatureControl {
  const constraint = getModelTemperatureConstraint(model);
  if (constraint.kind === 'default_only') {
    return {
      locked: true,
      reason: 'default_only',
      temperature: constraint.temperature,
    };
  }
  return { locked: false };
}
