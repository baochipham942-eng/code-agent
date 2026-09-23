import type { ToolDefinition } from '../../../shared/contract';
import type { ToolDescriptionContext } from '../../protocol/tools';
import { estimateTokens } from '../../context/tokenEstimator';
import { convertToolsToClaude, convertToolsToOpenAI } from '../../model/providers/shared';
import { convertToolsToResponses } from '../../model/providers/wrappers/responsesWrapper';

type SentToolShape = Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>;

/**
 * Description context carried on the tool call's modelConfig.
 * Measurement uses the same provider/model pair inference passes to dynamicDescription.
 */
export function descriptionContextFromModelConfig(
  modelConfig: unknown,
): { context?: ToolDescriptionContext; provider?: string } {
  if (!modelConfig || typeof modelConfig !== 'object') return {};
  const record = modelConfig as { provider?: unknown; model?: unknown };
  const provider = typeof record.provider === 'string' ? record.provider : undefined;
  const model = typeof record.model === 'string' ? record.model : undefined;
  if (!provider && !model) return {};
  return {
    context: { provider, model },
    ...(provider ? { provider } : {}),
  };
}

function providerWires(definition: SentToolShape, provider?: string): unknown[] {
  const wires = {
    claude: convertToolsToClaude([definition as ToolDefinition])[0],
    openai: convertToolsToOpenAI([definition as ToolDefinition])[0],
    openaiStrict: convertToolsToOpenAI([definition as ToolDefinition], true)[0],
    responses: convertToolsToResponses([definition as ToolDefinition])[0],
    gemini: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  };
  const key = (provider || '').trim().toLowerCase();
  if (key === 'claude' || key === 'anthropic') return [wires.claude];
  if (key === 'deepseek') return [wires.openaiStrict];
  if (key === 'responses') return [wires.responses];
  if (key === 'gemini') return [wires.gemini];
  if (!key) return [wires.claude, wires.openai, wires.openaiStrict, wires.responses, wires.gemini];
  return [wires.openai];
}

/** Token count of the provider wire JSON that would be sent for this definition. */
export function measureSentToolTokens(definition: SentToolShape, provider?: string): number {
  let largest = 0;
  for (const wire of providerWires(definition, provider)) {
    const tokens = estimateTokens(JSON.stringify(wire));
    if (tokens > largest) largest = tokens;
  }
  return largest;
}
