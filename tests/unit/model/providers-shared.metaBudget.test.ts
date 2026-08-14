// ============================================================================
// 全局 `_meta` 信封退役门
// ============================================================================
// schema 与提示词都不能重新注入全局信封；解析/剥离链路另有兼容测试，继续保留。
// ============================================================================

import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import { convertToolsToClaude, convertToolsToOpenAI } from '../../../src/host/model/providers/shared';
import { buildPrompt } from '../../../src/host/prompts/builder';

const probe: ToolDefinition = {
  name: 'probe',
  description: 'probe',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: false,
  permissionLevel: 'read',
};

describe('全局 _meta 信封退役', () => {
  it('Claude 工具 schema 不注入 _meta', () => {
    const schema = convertToolsToClaude([probe])[0].input_schema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).not.toHaveProperty('_meta');
  });

  it('OpenAI strict 工具 schema 不注入 _meta', () => {
    const tool = convertToolsToOpenAI([probe], true)[0];
    const schema = tool.function.parameters as { properties?: Record<string, unknown> };
    expect(tool.function.strict).toBe(true);
    expect(schema.properties).not.toHaveProperty('_meta');
  });

  it('系统提示不再要求工具调用输出语义信封，同时保留引用约定', () => {
    const prompt = buildPrompt();
    expect(prompt).not.toContain('Tool Call Envelope');
    expect(prompt).not.toContain('每一次** 调用任何工具');
    expect(prompt).not.toContain('shortDescription');
    expect(prompt).not.toContain('expectedOutcome');
    expect(prompt).toContain('## 引用约定');
    expect(prompt).toContain('`lineRange`');
  });
});
