// ============================================================================
// hookExecutionEngine — pure helper 单测
// 主流程（executeHooks / executeHook）由 hookManager.test.ts 间接覆盖
// 本文件验证 pure helpers 行为
// ============================================================================

import { describe, it, expect } from 'vitest';
import { getHookId } from '../../../src/host/hooks/hookExecutionEngine';
import type { HookDefinition } from '../../../src/host/hooks/configParser';

describe('getHookId', () => {
  it('command hook 用 command 串生成 ID', () => {
    const hook: HookDefinition = { type: 'command', command: 'echo hello' } as HookDefinition;
    expect(getHookId(hook)).toBe('command:echo hello');
  });

  it('prompt hook 用 prompt 串生成 ID', () => {
    const hook: HookDefinition = { type: 'prompt', prompt: 'check this' } as HookDefinition;
    expect(getHookId(hook)).toBe('prompt:check this');
  });

  it('agent hook 用 agent + agentPrompt 组合生成 ID', () => {
    const hook: HookDefinition = { type: 'agent', agent: 'reviewer', agentPrompt: 'p' } as HookDefinition;
    expect(getHookId(hook)).toBe('agent:reviewer:p');
  });

  it('agent hook 缺 agentPrompt 时尾部为空串', () => {
    const hook: HookDefinition = { type: 'agent', agent: 'reviewer' } as HookDefinition;
    expect(getHookId(hook)).toBe('agent:reviewer:');
  });

  it('http hook 用 url 生成 ID', () => {
    const hook: HookDefinition = { type: 'http', url: 'https://example.com/h' } as HookDefinition;
    expect(getHookId(hook)).toBe('http:https://example.com/h');
  });

  it('两个相同 command 生成相同 ID（用于 once 去重）', () => {
    const a: HookDefinition = { type: 'command', command: 'x' } as HookDefinition;
    const b: HookDefinition = { type: 'command', command: 'x' } as HookDefinition;
    expect(getHookId(a)).toBe(getHookId(b));
  });

  it('未知 type fallback 用 JSON 序列化', () => {
    const hook = { type: 'mystery', foo: 1 } as unknown as HookDefinition;
    expect(getHookId(hook)).toContain('unknown:');
    expect(getHookId(hook)).toContain('"type":"mystery"');
  });
});
