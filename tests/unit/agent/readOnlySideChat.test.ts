import { describe, expect, it, vi } from 'vitest';
import { runReadOnlySideChat } from '../../../src/host/agent/readOnlySideChat';
import type { SubagentConfig, SubagentContext, SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { Message } from '../../../src/shared/contract';

function fakeResult(output: string): SubagentResult {
  return { success: true, output, toolsUsed: [], iterations: 1 };
}

const baseContext = {
  modelConfig: { provider: 'openai', model: 'gpt-test' },
  toolResolver: {},
  toolContext: { workingDirectory: '/tmp' },
} as unknown as Pick<SubagentContext, 'modelConfig' | 'toolResolver' | 'toolContext'>;

const parentMessages = [
  { role: 'user', content: '帮我重构 foo.ts' },
  { role: 'assistant', content: '好的，正在拆分 foo.ts 的 god function' },
] as unknown as Message[];

describe('runReadOnlySideChat', () => {
  it('spawns a read-only subagent (no tools) inheriting parent context and returns its answer', async () => {
    const execute = vi.fn(async () => fakeResult('今天是周四'));

    const answer = await runReadOnlySideChat(
      { executor: { execute }, baseContext, parentMessages },
      '顺便问下，今天周几？',
    );

    expect(answer).toBe('今天是周四');
    expect(execute).toHaveBeenCalledTimes(1);

    const [prompt, config] = execute.mock.calls[0] as [string, SubagentConfig, SubagentContext];
    // 用户的岔开问题作为 prompt
    expect(prompt).toBe('顺便问下，今天周几？');
    // read-only：禁用所有工具
    expect(config.availableTools).toEqual([]);
    expect(config.name).toBe('side-chat');
    // 继承父上下文：系统提示里带到主会话最近的进展
    expect(config.systemPrompt).toContain('foo.ts');
  });

  it('passes through modelConfig/toolContext from the base context', async () => {
    const execute = vi.fn(async () => fakeResult('ok'));
    await runReadOnlySideChat({ executor: { execute }, baseContext, parentMessages }, 'q');
    const [, , ctx] = execute.mock.calls[0] as [string, SubagentConfig, SubagentContext];
    expect(ctx.modelConfig).toBe(baseContext.modelConfig);
    expect(ctx.toolContext).toBe(baseContext.toolContext);
  });

  it('works with no parent messages (empty context) and returns empty string when no output', async () => {
    const execute = vi.fn(async () => ({ ...fakeResult(''), output: '' }));
    const answer = await runReadOnlySideChat(
      { executor: { execute }, baseContext, parentMessages: [] },
      'hi',
    );
    expect(answer).toBe('');
    const [, config] = execute.mock.calls[0] as [string, SubagentConfig, SubagentContext];
    expect(config.availableTools).toEqual([]);
  });
});
