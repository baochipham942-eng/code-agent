// ============================================================================
// JevWarden 单测（N-JEV-WARDEN-MOCK）——判官全 mock / 依赖注入，无任何真实模型调用
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  createJevWarden,
  type JevWardenStepInput,
} from '../../../src/host/agent/runtime/jevWarden';
import {
  SIGNAL_ABAB_ACTION_CYCLE,
  SIGNAL_POLLING_REPEAT,
  SIGNAL_SAME_ERROR_FAMILY,
} from '../../../src/host/agent/runtime/doomLoopGuard';
import {
  JEV_WARDEN_QUESTIONS,
  JEV_WARDEN_THRESHOLDS,
  isJevWardenEnabled,
  type JevAnswers,
  type JevSystemOneCall,
} from '../../../src/shared/constants/jevQuestions';

const ENABLED_ENV = { CODE_AGENT_JEV_WARDEN: '1' } as NodeJS.ProcessEnv;

const bashResult = (command: string, success = true, summary = 'ok') => ({
  name: 'Bash',
  arguments: { command },
  success,
  summary,
});

const writeResult = (path: string, success = true) => ({
  name: 'write_file',
  arguments: { path },
  success,
  summary: success ? 'written' : 'EACCES denied',
});

const step = (overrides: Partial<JevWardenStepInput> = {}): JevWardenStepInput => ({
  guardLevel: 'none',
  guardSignals: [],
  stepResults: [],
  ...overrides,
});

const enabledWarden = (systemOne: JevSystemOneCall) =>
  createJevWarden({ systemOne, env: ENABLED_ENV });

const judgeReturning = (answers: JevAnswers): JevSystemOneCall => vi.fn().mockResolvedValue(answers);

describe('信号枚举共享（验收⑤）', () => {
  it('doomLoopGuard 导出现有三个信号常量，Warden 直接引用', () => {
    expect(SIGNAL_POLLING_REPEAT).toBe('polling_repeat');
    expect(SIGNAL_SAME_ERROR_FAMILY).toBe('same_error_family');
    expect(SIGNAL_ABAB_ACTION_CYCLE).toBe('abab_action_cycle');
  });
});

describe('JEV_WARDEN_* 常量块（验收②）', () => {
  it('三问全是 noul 窄问，阈值块存在', () => {
    expect(Object.keys(JEV_WARDEN_QUESTIONS).sort()).toEqual([
      'empty_spin',
      'fake_done',
      'irreversible_unapproved',
    ]);
    for (const spec of Object.values(JEV_WARDEN_QUESTIONS)) {
      expect(spec.type).toBe('noul');
      expect(spec.instructions.length).toBeGreaterThan(0);
    }
    expect(JEV_WARDEN_THRESHOLDS.emptySpin).toBeGreaterThan(0);
    expect(JEV_WARDEN_THRESHOLDS.fakeDone).toBeGreaterThan(0);
    expect(JEV_WARDEN_THRESHOLDS.irreversibleUnapproved).toBeGreaterThan(0);
  });

  it('开关 CODE_AGENT_JEV_WARDEN 默认关，仅显式 =1 开', () => {
    expect(isJevWardenEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isJevWardenEnabled({ CODE_AGENT_JEV_WARDEN: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isJevWardenEnabled({ CODE_AGENT_JEV_WARDEN: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('开关关时零行为变化（验收④）', () => {
  it('三条规则全命中也零调用判官、零转向、终局不拦', async () => {
    const systemOne = vi.fn();
    const warden = createJevWarden({ systemOne, env: {} as NodeJS.ProcessEnv });
    const verdict = await warden.reviewToolStep(step({
      guardLevel: 'doom-loop',
      guardSignals: [SIGNAL_POLLING_REPEAT],
      stepResults: [bashResult('rm -rf /tmp/x', false, 'boom'), writeResult('a.ts')],
      assistantText: 'All done, the task is complete.',
    }));
    expect(verdict).toEqual({ kind: 'none' });
    expect(systemOne).not.toHaveBeenCalled();
    expect(warden.interceptFinal(false)).toBeNull();
  });
});

describe('规则先判、命中才问（验收②）', () => {
  it('无规则命中时判官零调用', async () => {
    const systemOne = judgeReturning({});
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({
      stepResults: [{ name: 'read_file', arguments: { path: 'a.ts' }, success: true, summary: 'content' }],
    }));
    expect(verdict).toEqual({ kind: 'none' });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('empty_spin：guard 信号命中才问，一次请求只含 empty_spin 一问', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      stepResults: [{ name: 'task_output', arguments: { task_id: 't1' }, success: true, summary: 'status=running\n' }],
    }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1])).toEqual(['empty_spin']);
  });

  it('empty_spin：L1/L2 级别同样命中规则', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({ guardLevel: 'repeated-step' }));
    await warden.reviewToolStep(step({ guardLevel: 'doom-loop' }));
    expect(systemOne).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(systemOne).mock.calls) {
      expect(Object.keys(call[1])).toEqual(['empty_spin']);
    }
  });

  it('三条规则全命中时一次请求同发三问', async () => {
    const systemOne = judgeReturning({
      empty_spin: { noul: 0 },
      fake_done: { noul: 0 },
      irreversible_unapproved: { noul: 0 },
    });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_SAME_ERROR_FAMILY],
      stepResults: [bashResult('rm -rf /tmp/x', false, 'boom')],
      assistantText: 'Done.',
    }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1]).sort()).toEqual([
      'empty_spin',
      'fake_done',
      'irreversible_unapproved',
    ]);
  });

  it('fake_done：本步有失败工具结果即命中；state 带命名键 files_written 与 tool_results', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    // 先写成功一个文件，再制造失败步
    await warden.reviewToolStep(step({ stepResults: [writeResult('src/a.ts')] }));
    await warden.reviewToolStep(step({ stepResults: [bashResult('npm test', false, '1 failed')] }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    const state = vi.mocked(systemOne).mock.calls[0][0];
    expect(Array.isArray(state.files_written)).toBe(false);
    expect(Object.values(state.files_written as Record<string, string>)).toContain('src/a.ts');
    expect(Array.isArray(state.tool_results)).toBe(false);
    const results = Object.values(state.tool_results as Record<string, { success: boolean }>);
    expect(results.some((r) => r.success === false)).toBe(true);
  });

  it('fake_done：本步助手文本自称完成即命中', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({
      stepResults: [bashResult('ls')],
      assistantText: '已经全部完成，搞定了。',
    }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1])).toEqual(['fake_done']);
  });

  it('irreversible_unapproved：本步 shell 命令命中 isDangerousCommand 才问', async () => {
    const systemOne = judgeReturning({ irreversible_unapproved: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({ stepResults: [bashResult('rm -rf /tmp/data')] }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1])).toEqual(['irreversible_unapproved']);
  });

  it('files_written 只收成功写工具调用（失败写与 bash 不计）', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({
      stepResults: [writeResult('src/ok.ts'), writeResult('src/no.ts', false), bashResult('echo hi > x.txt')],
    }));
    await warden.reviewToolStep(step({ stepResults: [bashResult('npm test', false, 'fail')] }));
    const state = vi.mocked(systemOne).mock.calls[0][0];
    const files = Object.values(state.files_written as Record<string, string>);
    expect(files).toContain('src/ok.ts');
    expect(files).not.toContain('src/no.ts');
  });
});

describe('动作只转向（验收③）', () => {
  it('empty_spin 首次确认注入一条纠偏，再次确认强制收尾交还用户', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 0.95 } });
    const warden = enabledWarden(systemOne);
    const first = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_ABAB_ACTION_CYCLE] }));
    expect(first.kind).toBe('nudge');
    if (first.kind === 'nudge') expect(first.text).toContain('<jev-warden>');
    const second = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_ABAB_ACTION_CYCLE] }));
    expect(second.kind).toBe('force_wrap_up');
    if (second.kind === 'force_wrap_up') {
      expect(second.reason.length).toBeGreaterThan(0);
      expect(second.prompt.length).toBeGreaterThan(0);
    }
  });

  it('fake_done 置位后下一条非强制收尾终局被拦一次（每 run 至多一次），强制收尾不拦', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 1.0 } });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ stepResults: [bashResult('npm test', false, 'fail')] }));
    expect(verdict).toEqual({ kind: 'none' });
    expect(warden.interceptFinal(true)).toBeNull();
    const nudge = warden.interceptFinal(false);
    expect(nudge).toContain('<jev-warden>');
    expect(warden.interceptFinal(false)).toBeNull();
  });

  it('irreversible_unapproved 确认后强制收尾，说明已执行的不可逆动作并请用户确认', async () => {
    const systemOne = judgeReturning({ irreversible_unapproved: { noul: 0.9 } });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ stepResults: [bashResult('rm -rf /tmp/data')] }));
    expect(verdict.kind).toBe('force_wrap_up');
    if (verdict.kind === 'force_wrap_up') {
      expect(`${verdict.reason} ${verdict.prompt}`.toLowerCase()).toContain('irreversible');
      expect(verdict.prompt.toLowerCase()).toContain('confirm');
    }
  });

  it('verdict kind 全集只有 none / nudge / force_wrap_up，没有 deny', async () => {
    const systemOne = judgeReturning({
      empty_spin: { noul: 1 },
      fake_done: { noul: 1 },
      irreversible_unapproved: { noul: 1 },
    });
    const warden = enabledWarden(systemOne);
    const verdicts = [
      await warden.reviewToolStep(step({
        guardSignals: [SIGNAL_POLLING_REPEAT],
        stepResults: [bashResult('rm -rf /tmp/x', false, 'boom')],
        assistantText: 'done',
      })),
      await warden.reviewToolStep(step({ guardSignals: [SIGNAL_POLLING_REPEAT] })),
    ];
    for (const verdict of verdicts) {
      expect(['none', 'nudge', 'force_wrap_up']).toContain(verdict.kind);
    }
  });
});

describe('阈值与 fail-open（验收④）', () => {
  it('noul 低于阈值不转向', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: JEV_WARDEN_THRESHOLDS.emptySpin - 0.01 } });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_POLLING_REPEAT] }));
    expect(verdict).toEqual({ kind: 'none' });
  });

  it('判官抛错 fail-open 不转向', async () => {
    const systemOne: JevSystemOneCall = vi.fn().mockRejectedValue(new Error('network down'));
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_POLLING_REPEAT] }));
    expect(verdict).toEqual({ kind: 'none' });
  });

  it('判官超时 fail-open 不转向', async () => {
    const systemOne: JevSystemOneCall = vi.fn().mockRejectedValue(new Error('systemOne 超时（5000ms）或被外部中止'));
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_POLLING_REPEAT] }));
    expect(verdict).toEqual({ kind: 'none' });
  });

  it('判官返回坏形状 fail-open 不转向', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 'yes' as unknown as number } });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_POLLING_REPEAT] }));
    expect(verdict).toEqual({ kind: 'none' });
  });

  it('noul 越界（>1）按坏形状 fail-open', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 1.7 } });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({ guardSignals: [SIGNAL_POLLING_REPEAT] }));
    expect(verdict).toEqual({ kind: 'none' });
  });
});

describe('反向变异守门（验收⑥，常驻测试）', () => {
  it('三问恒 0 且三条规则全命中时零转向', async () => {
    const systemOne = judgeReturning({
      empty_spin: { noul: 0 },
      fake_done: { noul: 0 },
      irreversible_unapproved: { noul: 0 },
    });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      stepResults: [bashResult('rm -rf /tmp/x', false, 'boom')],
      assistantText: 'All done.',
    }));
    expect(verdict).toEqual({ kind: 'none' });
    expect(warden.interceptFinal(false)).toBeNull();
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it('fake_done 恒 1.0 且 files_written 为空时终局必须被拦', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 1.0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({ stepResults: [bashResult('npm test', false, 'fail')] }));
    expect(warden.interceptFinal(false)).not.toBeNull();
  });
});
