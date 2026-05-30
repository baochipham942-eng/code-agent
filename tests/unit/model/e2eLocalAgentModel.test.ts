import { describe, expect, it } from 'vitest';

import {
  buildE2ELocalAgentModelResponse,
  shouldUseE2ELocalAgentModel,
} from '../../../src/main/model/e2eLocalAgentModel';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/main/model/types';

const config: ModelConfig = {
  provider: 'openai',
  model: 'e2e-local-agent-model',
  apiKey: 'test',
  maxTokens: 1000,
};

const readTool: ToolDefinition = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
    },
    required: ['file_path'],
  },
  requiresPermission: false,
  permissionLevel: 'read',
};

describe('e2eLocalAgentModel', () => {
  it('requires both E2E env guards', () => {
    expect(shouldUseE2ELocalAgentModel({ CODE_AGENT_E2E: '1' })).toBe(false);
    expect(shouldUseE2ELocalAgentModel({ CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1' })).toBe(false);
    expect(shouldUseE2ELocalAgentModel({
      CODE_AGENT_E2E: '1',
      CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1',
    })).toBe(true);
  });

  it('calls the real Read tool before producing the final eval response', () => {
    const first = buildE2ELocalAgentModelResponse(
      [{ role: 'user', content: 'read the fixture' }],
      [readTool],
      config,
      undefined,
      {
        CODE_AGENT_E2E_AGENT_MODEL_READ_FILE: '/tmp/e2e-fixture.txt',
      },
    );

    expect(first.type).toBe('tool_use');
    expect(first.toolCalls?.[0]).toMatchObject({
      id: 'e2e-real-agent-read-fixture',
      name: 'Read',
      arguments: {
        file_path: '/tmp/e2e-fixture.txt',
      },
    });

    const toolResult: ModelMessage = {
      role: 'tool',
      toolCallId: 'e2e-real-agent-read-fixture',
      content: 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE=true',
    };
    const final = buildE2ELocalAgentModelResponse(
      [toolResult],
      [readTool],
      config,
    );

    expect(final.type).toBe('text');
    expect(final.content).toContain('E2E real agent replay eval smoke completed');
    expect(final.content).toContain('E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE');
  });
});
