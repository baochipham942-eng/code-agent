import type { CapabilityInstallDraftSpec } from '../../../shared/contract/capability';

function normalizeDraftInputValue(key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Draft input "${key}" must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Draft input "${key}" is required`);
  }
  if ([...trimmed].some((char) => char.charCodeAt(0) === 0 || char === '\r' || char === '\n') || /\{\{[^}]+\}\}/.test(trimmed)) {
    throw new Error(`Draft input "${key}" contains unsupported characters`);
  }
  return trimmed;
}

function resolveDraftTemplateValue(value: unknown, inputs: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, rawKey: string) => {
      const key = rawKey.trim();
      if (!Object.prototype.hasOwnProperty.call(inputs, key)) {
        throw new Error(`Missing draft input: ${key}`);
      }
      return inputs[key] || '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveDraftTemplateValue(entry, inputs));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveDraftTemplateValue(entry, inputs),
      ]),
    );
  }
  return value;
}

export function resolveInstallDraftConfig(
  draft: CapabilityInstallDraftSpec,
  rawInputs: Record<string, string> | undefined,
): Record<string, unknown> {
  const normalizedInputs: Record<string, string> = {};
  for (const parameter of draft.parameters || []) {
    normalizedInputs[parameter.key] = normalizeDraftInputValue(parameter.key, rawInputs?.[parameter.key]);
  }
  const resolved = resolveDraftTemplateValue(draft.config, normalizedInputs);
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error('Capability draft config must resolve to an object');
  }
  if (/\{\{[^}]+\}\}/.test(JSON.stringify(resolved))) {
    throw new Error('Capability draft config contains unresolved placeholders');
  }
  return resolved as Record<string, unknown>;
}
