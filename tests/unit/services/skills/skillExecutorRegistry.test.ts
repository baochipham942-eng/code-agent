import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasSkillExecutor,
  registerSkillExecutor,
  runRegisteredSkillExecutor,
  unregisterSkillExecutor,
} from '../../../../src/main/services/skills/skillExecutorRegistry';

const NAME = 'test-executor-skill';

function request(overrides: Partial<Parameters<typeof runRegisteredSkillExecutor>[0]> = {}) {
  return {
    skillName: NAME,
    args: undefined as string | undefined,
    workingDirectory: '/repo',
    matchKind: 'slash' as const,
    ...overrides,
  };
}

afterEach(() => {
  unregisterSkillExecutor(NAME);
});

describe('skillExecutorRegistry', () => {
  it('未注册的 skill → null（调用方按普通 skill 处理）', async () => {
    expect(hasSkillExecutor('nonexistent-skill')).toBe(false);
    expect(await runRegisteredSkillExecutor(request({ skillName: 'nonexistent-skill' }))).toBeNull();
  });

  it('显式 slash 触发 → 执行并返回 completed 报告', async () => {
    const executor = vi.fn(async () => 'six-phase report text');
    registerSkillExecutor(NAME, executor);

    const outcome = await runRegisteredSkillExecutor(request({ args: '--auto' }));
    expect(outcome).toMatchObject({ status: 'completed', report: 'six-phase report text' });
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ args: '--auto', matchKind: 'slash' }));
  });

  it('守护 1：alias 模糊匹配不触发执行（仅显式 slash/inline-slash）', async () => {
    const executor = vi.fn(async () => 'should not run');
    registerSkillExecutor(NAME, executor);

    const outcome = await runRegisteredSkillExecutor(request({ matchKind: 'alias' }));
    expect(outcome).toMatchObject({ status: 'skipped-not-explicit' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('守护 2：executor 抛错 → failed 降级报告，绝不向上抛', async () => {
    registerSkillExecutor(NAME, async () => {
      throw new Error('pipeline exploded');
    });

    const outcome = await runRegisteredSkillExecutor(request());
    expect(outcome?.status).toBe('failed');
    expect(outcome?.report).toContain('pipeline exploded');
  });

  it('守护 3：并发互斥 — 运行中再次显式触发 → busy，不重复执行', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = vi.fn(async () => {
      await gate;
      return 'done';
    });
    registerSkillExecutor(NAME, executor);

    const first = runRegisteredSkillExecutor(request());
    const second = await runRegisteredSkillExecutor(request());
    expect(second?.status).toBe('busy');
    expect(executor).toHaveBeenCalledTimes(1);

    release();
    expect((await first)?.status).toBe('completed');

    // 完成后可再次执行
    const third = await runRegisteredSkillExecutor(request());
    expect(third?.status).toBe('completed');
  });

  it('守护 4：执行超时 → timeout 降级报告，不拖死消息链路', async () => {
    registerSkillExecutor(
      NAME,
      () => new Promise<string>(() => { /* never settles */ }),
      { timeoutMs: 20 },
    );

    const outcome = await runRegisteredSkillExecutor(request());
    expect(outcome?.status).toBe('timeout');
    expect(outcome?.report).toMatch(/超时|timeout/i);
  });
});
