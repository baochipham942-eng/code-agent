import { estimateTokens } from '../../context/tokenEstimator';
import { DEFERRED_TOOL_LOADING } from '../../../shared/constants/tools';

/** Claude tool JSON: name, description, input_schema. This is the schema injection shape. */
export interface InjectedToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function claudeToolInjectionText(schema: InjectedToolSchema): string {
  return JSON.stringify({
    name: schema.name,
    description: schema.description,
    input_schema: schema.input_schema,
  });
}

function singleInjectionTokens(text: string, schemas: readonly InjectedToolSchema[]): number {
  return estimateTokens(text) + schemas.reduce(
    (sum, schema) => sum + estimateTokens(claudeToolInjectionText(schema)),
    0,
  );
}

function sliceToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || !text) return '';
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(0, middle);
    if (estimateTokens(candidate) <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'description') continue;
    out[key] = withoutDescriptions(child);
  }
  return out;
}

function shrinkSchema(schema: InjectedToolSchema, budget: number): InjectedToolSchema | null {
  if (budget <= 0) return null;
  if (estimateTokens(claudeToolInjectionText(schema)) <= budget) return schema;
  const empty = { ...schema, description: '' };
  if (estimateTokens(claudeToolInjectionText(empty)) > budget) {
    const stripped: InjectedToolSchema = {
      ...empty,
      input_schema: withoutDescriptions(schema.input_schema) as Record<string, unknown>,
    };
    return estimateTokens(claudeToolInjectionText(stripped)) <= budget ? stripped : null;
  }
  let low = 0;
  let high = schema.description.length;
  let best = empty;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...schema, description: schema.description.slice(0, middle) };
    if (estimateTokens(claudeToolInjectionText(candidate)) <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Fit ToolSearch text and newly loaded schemas into one ceiling.
 * Full schemas stay when they fit beside the result text. Otherwise descriptions
 * shrink, including nested parameter descriptions, so names and types stay callable.
 * A schema that still cannot fit is omitted; the caller must not inject it.
 */
export function boundSingleInjection(input: {
  text: string;
  namesText: string;
  schemas: readonly InjectedToolSchema[];
  ceiling?: number;
}): { text: string; schemas: InjectedToolSchema[] } {
  const ceiling = input.ceiling ?? DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING;
  const originals = input.schemas.map((schema) => ({ ...schema, input_schema: schema.input_schema }));
  const fitText = (budget: number): string => {
    if (budget <= 0) return '';
    if (estimateTokens(input.text) <= budget) return input.text;
    if (estimateTokens(input.namesText) <= budget) return input.namesText;
    return sliceToTokenBudget(input.namesText || input.text, budget);
  };

  if (singleInjectionTokens(input.text, originals) <= ceiling) {
    return { text: input.text, schemas: originals };
  }
  if (singleInjectionTokens(input.namesText, originals) <= ceiling) {
    return {
      text: fitText(ceiling - originals.reduce((sum, schema) => sum + estimateTokens(claudeToolInjectionText(schema)), 0)),
      schemas: originals,
    };
  }

  const namesTokens = estimateTokens(input.namesText);
  const schemaBudget = Math.max(0, ceiling - Math.min(namesTokens, ceiling));
  const ordered = [...originals].sort(
    (left, right) => estimateTokens(claudeToolInjectionText(left)) - estimateTokens(claudeToolInjectionText(right)),
  );
  const kept: InjectedToolSchema[] = [];
  let used = 0;
  for (const schema of ordered) {
    const shrunk = shrinkSchema(schema, schemaBudget - used);
    if (!shrunk) continue;
    kept.push(shrunk);
    used += estimateTokens(claudeToolInjectionText(shrunk));
  }
  let text = fitText(ceiling - used);
  if (singleInjectionTokens(text, kept) > ceiling) {
    text = sliceToTokenBudget(text, Math.max(0, ceiling - used));
  }
  return { text, schemas: kept };
}
