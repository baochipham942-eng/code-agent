// ============================================================================
// Hook 决策原因摘要（reason）与 onStart 信号测试
// ============================================================================
// reason：block/modify 时从 message 提炼的单行摘要（首个非空行、截 120 字、脱敏），
// 是会话区唯一允许上屏的 hook 文本——完整输出（message）仍只进观测日志。
// onStart：hook 批次开跑信号，与 hook_trigger 配对，会话区据此显示 running 指示。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../../../src/host/hooks/hookManager';
import type { HookStartInfo, TriggerHistoryEntry } from '../../../src/host/hooks/hookManager';
import type { MergedHookConfig } from '../../../src/host/hooks/merger';

vi.mock('../../../src/host/hooks/configParser', () => ({
  loadAllHooksConfig: vi.fn().mockResolvedValue([]),
  matchesCondition: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/host/hooks/merger', () => ({
  mergeHooks: vi.fn().mockReturnValue([]),
  getHooksForTool: vi.fn().mockReturnValue([]),
  getHooksForEvent: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/host/hooks/builtinHookExecutor', () => ({
  getBuiltinHookExecutor: vi.fn().mockReturnValue({
    executeForEvent: vi.fn().mockResolvedValue([]),
  }),
}));

function scriptConfig(event: MergedHookConfig['event'], command: string, name?: string): MergedHookConfig {
  return {
    event,
    matcher: null,
    hooks: [{ type: 'command', command, ...(name ? { name } : {}) }],
    sources: ['project'],
    parallel: false,
    hookType: 'decision',
  };
}

describe('Hook 决策原因摘要（trigger history reason）', () => {
  let manager: HookManager;
  let triggers: TriggerHistoryEntry[];

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks 只清调用记录不清实现——显式复位，防测试间 mock 泄漏
    const merger = await import('../../../src/host/hooks/merger');
    vi.mocked(merger.getHooksForTool).mockReturnValue([]);
    vi.mocked(merger.getHooksForEvent).mockReturnValue([]);
    triggers = [];
    manager = new HookManager({
      workingDirectory: '/tmp',
      onTrigger: (entry) => triggers.push(entry),
    });
    await manager.initialize();
  });

  it('block 时 reason 取 message 首个非空行', async () => {
    const { getHooksForEvent } = await import('../../../src/host/hooks/merger');
    vi.mocked(getHooksForEvent).mockReturnValue([
      scriptConfig('Stop', "printf '\\n第一行原因\\n第二行细节\\n'; exit 1"),
    ]);

    const result = await manager.triggerStop('done', 'session-1');

    expect(result.shouldProceed).toBe(false);
    const entry = manager.getTriggerHistory().at(-1);
    expect(entry?.action).toBe('block');
    expect(entry?.reason).toBe('第一行原因');
    // 完整输出仍在 message（观测日志用），reason 只是单行摘要
    expect(entry?.message).toContain('第二行细节');
    expect(triggers.at(-1)?.reason).toBe('第一行原因');
  });

  it('reason 超过 120 字时截断并加省略号', async () => {
    const { getHooksForEvent } = await import('../../../src/host/hooks/merger');
    const longReason = '长'.repeat(200);
    vi.mocked(getHooksForEvent).mockReturnValue([
      scriptConfig('Stop', `printf '${longReason}'; exit 1`),
    ]);

    await manager.triggerStop('done', 'session-1');

    const entry = manager.getTriggerHistory().at(-1);
    expect(entry?.reason).toBe(`${'长'.repeat(120)}…`);
  });

  it('放行且无改写时不产出 reason（message 只是注入上下文，不是决策原因）', async () => {
    const { getHooksForEvent } = await import('../../../src/host/hooks/merger');
    // observer：任意非 error 的 message 都会收进 trigger 结果（decision 只在 continue/block 时收）
    vi.mocked(getHooksForEvent).mockReturnValue([
      { ...scriptConfig('UserPromptSubmit', "printf '注入的背景知识'"), hookType: 'observer' },
    ]);

    const result = await manager.triggerUserPromptSubmit('hello', 'session-1');

    expect(result.shouldProceed).toBe(true);
    const entry = manager.getTriggerHistory().at(-1);
    expect(entry?.message).toBe('注入的背景知识');
    expect(entry?.reason).toBeUndefined();
  });

  it('改写输入（modifiedInput）时 reason 取 hook 给的说明', async () => {
    const { getHooksForTool } = await import('../../../src/host/hooks/merger');
    // 引擎契约：decision hook 的 message/modifiedInput 走 continue 动作才会被收集
    vi.mocked(getHooksForTool).mockReturnValue([
      scriptConfig('PreToolUse', "printf '{\"action\":\"continue\",\"message\":\"已改成只读命令\",\"modifiedInput\":\"ls\"}'"),
    ]);

    const result = await manager.triggerPreToolUse('Bash', 'rm -rf x', 'session-1');

    expect(result.shouldProceed).toBe(true);
    expect(result.modifiedInput).toBe('ls');
    const entry = manager.getTriggerHistory().at(-1);
    expect(entry?.modified).toBe(true);
    expect(entry?.reason).toBe('已改成只读命令');
  });

  it('reason 里的敏感信息同样脱敏', async () => {
    const { getHooksForEvent } = await import('../../../src/host/hooks/merger');
    const leakedKey = 'sk-ant-api03-' + 'a'.repeat(90);
    vi.mocked(getHooksForEvent).mockReturnValue([
      scriptConfig('Stop', `printf 'blocked with key ${leakedKey}'; exit 1`),
    ]);

    await manager.triggerStop('done', 'session-1');

    const entry = manager.getTriggerHistory().at(-1);
    expect(entry?.reason).toBeDefined();
    expect(entry?.reason).not.toContain(leakedKey);
  });

  it('横跨 120 字截断点的 secret 不进 reason（先脱敏再截断，顺序不能反）', async () => {
    const { getHooksForEvent } = await import('../../../src/host/hooks/merger');
    // 密钥起点在第 111 字：旧顺序（先截断）会把密钥拦腰切成 10 字残段，
    // 残段不满足 mask 的 token 匹配（sk-ant- 后需 90+ 字符）→ 半截密钥上屏
    const leakedKey = 'sk-ant-api03-' + 'a'.repeat(90);
    const prefix = 'A'.repeat(110);
    vi.mocked(getHooksForEvent).mockReturnValue([
      scriptConfig('Stop', `printf '${prefix}${leakedKey}'; exit 1`),
    ]);

    await manager.triggerStop('done', 'session-1');

    const entry = manager.getTriggerHistory().at(-1);
    expect(entry?.reason).toBeDefined();
    expect(entry?.reason).not.toContain(leakedKey);
    // 残段也不行：连密钥前缀特征都不能出现
    expect(entry?.reason).not.toContain('sk-ant-api03');
    expect(entry?.reason).not.toContain('a'.repeat(20));
  });
});

describe('Hook onStart 信号（hook_started）', () => {
  let manager: HookManager;
  let starts: HookStartInfo[];
  let triggers: TriggerHistoryEntry[];

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks 只清调用记录不清实现——显式复位，防测试间 mock 泄漏
    const merger = await import('../../../src/host/hooks/merger');
    vi.mocked(merger.getHooksForTool).mockReturnValue([]);
    vi.mocked(merger.getHooksForEvent).mockReturnValue([]);
    starts = [];
    triggers = [];
    manager = new HookManager({
      workingDirectory: '/tmp',
      onStart: (info) => starts.push(info),
      onTrigger: (entry) => triggers.push(entry),
    });
    await manager.initialize();
  });

  it('有匹配 hook 时先发 onStart 再落 hook_trigger，带事件名与 hook 名', async () => {
    const { getHooksForTool } = await import('../../../src/host/hooks/merger');
    vi.mocked(getHooksForTool).mockReturnValue([
      scriptConfig('PreToolUse', "printf 'ok'", '命令门禁'),
    ]);

    await manager.triggerPreToolUse('Bash', 'echo hi', 'session-1');

    expect(starts).toHaveLength(1);
    expect(starts[0]?.event).toBe('PreToolUse');
    expect(starts[0]?.names).toEqual(['命令门禁']);
    expect(starts[0]?.toolName).toBe('Bash');
    // 配对信号：running 指示靠 trigger 撤下，两者都不能少
    expect(triggers).toHaveLength(1);
    expect(starts[0]?.timestamp).toBeLessThanOrEqual(triggers[0]?.timestamp ?? 0);
  });

  it('没有匹配 hook 时不发 onStart', async () => {
    await manager.triggerPreToolUse('Bash', 'echo hi', 'session-1');

    expect(starts).toHaveLength(0);
    expect(triggers).toHaveLength(0);
  });

  it('onStart 观察者抛错不影响 hook 执行', async () => {
    const { getHooksForEvent } = await import('../../../src/host/hooks/merger');
    vi.mocked(getHooksForEvent).mockReturnValue([
      scriptConfig('Stop', "printf 'ok'"),
    ]);
    const faulty = new HookManager({
      workingDirectory: '/tmp',
      onStart: () => { throw new Error('observer exploded'); },
    });
    await faulty.initialize();

    const result = await faulty.triggerStop('done', 'session-1');

    expect(result.shouldProceed).toBe(true);
  });
});
