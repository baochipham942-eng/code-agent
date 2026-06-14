import type { ModelResponse } from '../../src/main/model/types';
import type { ToolCall } from '../../src/shared/contract';

export interface XiaomiProviderResponseArtifact {
  provider: 'xiaomi';
  model: string;
  scenario: 'tool-calling';
  capturedAt: string;
  usage: ModelResponse['usage'] | null;
  toolCalls: Array<Pick<ToolCall, 'name' | 'arguments'>>;
}

export function buildXiaomiProviderResponseArtifact(args: {
  model: string;
  response: Pick<ModelResponse, 'usage' | 'toolCalls'>;
  capturedAt?: string;
}): XiaomiProviderResponseArtifact {
  return {
    provider: 'xiaomi',
    model: args.model,
    scenario: 'tool-calling',
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    usage: args.response.usage ?? null,
    toolCalls: (args.response.toolCalls ?? []).map((call) => ({
      name: call.name,
      arguments: call.arguments,
    })),
  };
}
