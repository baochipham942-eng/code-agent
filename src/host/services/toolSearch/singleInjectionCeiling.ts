import { estimateTokens } from '../../context/tokenEstimator';
import { DEFERRED_TOOL_LOADING } from '../../../shared/constants/tools';

/** Semantic tool schema. Descriptions and parameters are never trimmed to fit a ceiling. */
export interface InjectedToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Provider-normalized wire size. Falls back to Claude-shaped JSON when omitted. */
  sentTokens?: number;
}

function claudeToolInjectionText(schema: InjectedToolSchema): string {
  return JSON.stringify({
    name: schema.name,
    description: schema.description,
    input_schema: schema.input_schema,
  });
}

function schemaTokensOf(schemas: readonly InjectedToolSchema[], override?: number): number {
  if (override !== undefined) return override;
  return schemas.reduce((sum, schema) => {
    if (schema.sentTokens !== undefined) return sum + schema.sentTokens;
    return sum + estimateTokens(claudeToolInjectionText(schema));
  }, 0);
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

function textWithin(text: string, namesText: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  if (namesText && estimateTokens(namesText) <= budget) return namesText;
  return sliceToTokenBudget(namesText || text, budget);
}

/**
 * Fit ToolSearch result text beside newly loaded full schemas.
 * Schemas stay intact. When the schemas themselves exceed the ceiling, none are returned.
 * `measured` is the unfitted total: result text plus provider-normalized schema tokens.
 */
export function boundSingleInjection(input: {
  text: string;
  namesText: string;
  schemas: readonly InjectedToolSchema[];
  ceiling?: number;
  schemaTokens?: number;
}): { text: string; schemas: InjectedToolSchema[]; measured: number; fitsSchemas: boolean } {
  const ceiling = input.ceiling ?? DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING;
  const originals = input.schemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.input_schema,
    ...(schema.sentTokens !== undefined ? { sentTokens: schema.sentTokens } : {}),
  }));
  const schemaTokens = schemaTokensOf(originals, input.schemaTokens);
  const measured = estimateTokens(input.text) + schemaTokens;
  if (schemaTokens > ceiling) {
    return {
      text: textWithin(input.namesText || input.text, input.namesText, ceiling),
      schemas: [],
      measured,
      fitsSchemas: false,
    };
  }
  return {
    text: textWithin(input.text, input.namesText, ceiling - schemaTokens),
    schemas: originals,
    measured,
    fitsSchemas: true,
  };
}
