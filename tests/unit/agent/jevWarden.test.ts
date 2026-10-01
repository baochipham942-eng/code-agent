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
      // R2 #3 后危险命令要成功执行才算；fake_done 由另一条失败结果命中
      stepResults: [bashResult('rm -rf /tmp/x'), bashResult('npm test', false, 'boom')],
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
      // R2 #3 口径：成功的危险命令命中 irreversible；失败结果命中 fake_done
      stepResults: [bashResult('rm -rf /tmp/x'), bashResult('npm test', false, 'boom')],
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

describe('审查修复轮 R2', () => {
  it('state 统一过 guardSensitiveText：夹具密钥原文不外发（R2 #1）', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({
      stepResults: [bashResult('cat .env', false, 'api_key=sk-fixture-secret-123456')],
      assistantText: '看到 token=tok-fixture-abcdef-123456，但还没完成',
    }));
    const stateJson = JSON.stringify(vi.mocked(systemOne).mock.calls[0][0]);
    expect(stateJson).not.toContain('sk-fixture-secret-123456');
    expect(stateJson).not.toContain('tok-fixture-abcdef-123456');
  });

  it('失败/被拒的危险命令不算已执行：不进 dangerous_commands、不触发 irreversible 问句（R2 #3）', async () => {
    const systemOne = judgeReturning({ fake_done: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({
      stepResults: [bashResult('rm -rf /tmp/x', false, 'permission denied by user')],
    }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1])).toEqual(['fake_done']);
    const state = vi.mocked(systemOne).mock.calls[0][0];
    expect(Object.keys(state.dangerous_commands as Record<string, unknown>)).toHaveLength(0);
  });

  it('权限层 ask-approved 的危险命令规则层短路不问；auto-approve 仍问且 state 带 approval 凭据（R2 #5）', async () => {
    const systemOne = judgeReturning({ irreversible_unapproved: { noul: 0 } });
    const approvedWarden = createJevWarden({
      systemOne, env: ENABLED_ENV, approvalLookup: () => 'ask-approved',
    });
    await approvedWarden.reviewToolStep(step({ stepResults: [bashResult('rm -rf /tmp/data')] }));
    expect(systemOne).not.toHaveBeenCalled();

    const autoWarden = createJevWarden({
      systemOne, env: ENABLED_ENV, approvalLookup: () => 'auto-approve',
    });
    await autoWarden.reviewToolStep(step({ stepResults: [bashResult('rm -rf /tmp/data')] }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1])).toEqual(['irreversible_unapproved']);
    const state = vi.mocked(systemOne).mock.calls[0][0];
    const commands = Object.values(state.dangerous_commands as Record<string, { approval: string }>);
    expect(commands).toHaveLength(1);
    expect(commands[0].approval).toBe('auto-approve');
  });

  it('缺审批记录（unknown）按未确认处理：仍问且 state 标 unknown（R2 #5）', async () => {
    const systemOne = judgeReturning({ irreversible_unapproved: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    await warden.reviewToolStep(step({ stepResults: [bashResult('rm -rf /tmp/data')] }));
    const state = vi.mocked(systemOne).mock.calls[0][0];
    const commands = Object.values(state.dangerous_commands as Record<string, { approval: string }>);
    expect(commands[0].approval).toBe('unknown');
  });

  it('run 已取消（signal 已 aborted）时判官零调用、零转向（R2 #4）', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 1 } });
    const warden = enabledWarden(systemOne);
    const controller = new AbortController();
    controller.abort();
    const verdict = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      signal: controller.signal,
    }));
    expect(verdict).toEqual({ kind: 'none' });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('run abort signal 透传给 systemOne，判官请求随取消中断（R2 #4）', async () => {
    const systemOne = judgeReturning({ empty_spin: { noul: 0 } });
    const warden = enabledWarden(systemOne);
    const controller = new AbortController();
    await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      signal: controller.signal,
    }));
    expect(vi.mocked(systemOne).mock.calls[0][2]?.signal).toBe(controller.signal);
  });
});

describe('审查修复轮 R3 — 判官等待期间 steer 的旧裁决丢弃', () => {
  it('判官等待期间发生 steer：裁决丢弃，计数/置标/收尾全部不提交（R3）', async () => {
    let epoch = 0;
    const systemOne: JevSystemOneCall = vi.fn()
      // 第一次判官 await 期间用户 steer（epoch 推进）；之后 epoch 稳定
      .mockImplementationOnce(async () => {
        epoch += 1;
        return { empty_spin: { noul: 0.95 } };
      })
      .mockResolvedValue({ empty_spin: { noul: 0.95 } });
    const warden = createJevWarden({ systemOne, env: ENABLED_ENV });
    const stale = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      steerEpoch: () => epoch,
    }));
    expect(stale).toEqual({ kind: 'none' });
    // 计数未提交：epoch 稳定后再确认，应仍算「首次」→ nudge 而非 force_wrap_up
    const fresh = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      steerEpoch: () => epoch,
    }));
    expect(fresh.kind).toBe('nudge');
  });

  it('判官等待期间发生 steer：fake_done 置标不提交，终局不拦（R3）', async () => {
    let epoch = 0;
    const systemOne: JevSystemOneCall = vi.fn().mockImplementation(async () => {
      epoch += 1;
      return { fake_done: { noul: 1.0 } };
    });
    const warden = createJevWarden({ systemOne, env: ENABLED_ENV });
    const verdict = await warden.reviewToolStep(step({
      stepResults: [bashResult('npm test', false, 'fail')],
      steerEpoch: () => epoch,
    }));
    expect(verdict).toEqual({ kind: 'none' });
    expect(warden.interceptFinal(false)).toBeNull();
  });

  it('判官等待期间未 steer（epoch 稳定）：裁决照常生效（R3）', async () => {
    const epoch = 7;
    const systemOne = judgeReturning({ irreversible_unapproved: { noul: 0.9 } });
    const warden = createJevWarden({ systemOne, env: ENABLED_ENV });
    const verdict = await warden.reviewToolStep(step({
      stepResults: [bashResult('rm -rf /tmp/data')],
      steerEpoch: () => epoch,
    }));
    expect(verdict.kind).toBe('force_wrap_up');
  });
});

describe('审查修复轮 R4 — 混合答案坏形状整体 fail-open', () => {
  it('命中题中任一坏形状 → 整体 verdict none（计数不增、不置标、不转向），有效答案不单独生效（R4 #2）', async () => {
    const systemOne = judgeReturning({
      empty_spin: { noul: 'yes' as unknown as number },
      irreversible_unapproved: { noul: 0.9 },
    });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      stepResults: [bashResult('rm -rf /tmp/data')],
    }));
    expect(verdict).toEqual({ kind: 'none' });
    // 计数未提交：下一次全好形状确认仍算「首次」→ nudge 而非 force_wrap_up
    vi.mocked(systemOne).mockResolvedValue({
      empty_spin: { noul: 0.95 },
      irreversible_unapproved: { noul: 0 },
    });
    const fresh = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      stepResults: [bashResult('rm -rf /tmp/data')],
    }));
    expect(fresh.kind).toBe('nudge');
  });

  it('全部好形状 → 各题照常生效（R4 #2 对照）', async () => {
    const systemOne = judgeReturning({
      empty_spin: { noul: 0 },
      irreversible_unapproved: { noul: 0.9 },
    });
    const warden = enabledWarden(systemOne);
    const verdict = await warden.reviewToolStep(step({
      guardSignals: [SIGNAL_POLLING_REPEAT],
      stepResults: [bashResult('rm -rf /tmp/data')],
    }));
    expect(verdict.kind).toBe('force_wrap_up');
  });
});

describe('审查修复轮 R5 — 审批凭据完整命令精确匹配', () => {
  // 两条共享 80 字符前缀、尾部不同的危险命令
  const CMD_A = `rm -rf /tmp/${'a'.repeat(100)}`;
  const CMD_B = `rm -rf /tmp/${'a'.repeat(100)}-evil`;

  it('recordDecision 落账带完整命令指纹（fullCommand）', async () => {
    const { recordDecision } = await import('../../../src/host/tools/toolExecutorDecisionTrace');
    const { getDecisionHistory, resetDecisionHistory } = await import('../../../src/host/security/decisionHistory');
    resetDecisionHistory();
    recordDecision('Bash', { command: CMD_A }, 'ask-approved', 'user confirmed', Date.now(), undefined, 's1');
    const entries = getDecisionHistory().getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].fullCommand).toBe(CMD_A);
    resetDecisionHistory();
  });

  it('批准 A 不让同前缀未批准的 B 跳过不可逆判面（R5 #2）', async () => {
    const { getDecisionHistory, resetDecisionHistory } = await import('../../../src/host/security/decisionHistory');
    resetDecisionHistory();
    getDecisionHistory().record({
      timestamp: Date.now(),
      toolName: 'Bash',
      summary: CMD_A.substring(0, 80),
      fullCommand: CMD_A,
      outcome: 'ask-approved',
      reason: 'user confirmed',
      durationMs: 0,
      sessionId: 's1',
    });
    const systemOne = judgeReturning({ irreversible_unapproved: { noul: 0 } });
    const warden = createJevWarden({ systemOne, env: ENABLED_ENV, sessionId: 's1' });

    // A 本人：显式批准过 → 规则层短路不问
    await warden.reviewToolStep(step({ stepResults: [bashResult(CMD_A)] }));
    expect(systemOne).not.toHaveBeenCalled();

    // B：同 80 字符前缀但尾部不同 → 不算确认凭据，照旧触发 irreversible 判面
    await warden.reviewToolStep(step({ stepResults: [bashResult(CMD_B)] }));
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(systemOne).mock.calls[0][1])).toEqual(['irreversible_unapproved']);
    resetDecisionHistory();
  });
});
