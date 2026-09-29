// ============================================================================
// PlanExitFallback — ADR-074 slice 1（N-PLANEXIT-K1）
// 判据/预算/提醒经公共入口 planExitFallbackStep 测（knip production 棘轮禁仅测试导出，
// 结构判据不单独导出）；② 的词表缺席测试直接读本模块源码。
// ============================================================================

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createPlanExitFallbackState,
  isWriteBlockedDuringPlanExitFallback,
  planExitFallbackStep,
  type PlanExitFallbackDetectedData,
  type PlanExitFallbackNotApplicableData,
  type PlanExitFallbackState,
} from '../../../src/host/agent/runtime/planExitFallback';

const PLAN_BODY = ['我的方案：', '1. 梳理现有接口', '2. 抽出公共层', '3. 补齐用例'].join('\n');

interface StepInputWithSpies {
  state: PlanExitFallbackState;
  response: { type: string; content?: string; toolCalls?: readonly unknown[] };
  planModeActive: boolean;
  forcedFinalPass: boolean;
  cancelled: boolean;
  runKey: string | undefined;
  emitDetected: Mock<(data: PlanExitFallbackDetectedData) => void>;
  emitNotApplicable: Mock<(data: PlanExitFallbackNotApplicableData) => void>;
  remind: Mock<(reminderText: string) => void>;
}

function makeStepInput(overrides: Partial<StepInputWithSpies> = {}): StepInputWithSpies {
  return {
    state: createPlanExitFallbackState(),
    response: { type: 'text', content: PLAN_BODY },
    planModeActive: true,
    forcedFinalPass: false,
    cancelled: false,
    runKey: 'run-1',
    emitDetected: vi.fn<(data: PlanExitFallbackDetectedData) => void>(),
    emitNotApplicable: vi.fn<(data: PlanExitFallbackNotApplicableData) => void>(),
    remind: vi.fn<(reminderText: string) => void>(),
    ...overrides,
  };
}

describe('planExitFallbackStep 判据（只看结构与标点，经公共入口）', () => {
  it.each([
    ['有序 1. 列表', '方案：\n1. 第一步\n2. 第二步'],
    ['有序 1) 列表', 'Plan:\n1) first\n2) second'],
    ['① 圆号列表', '计划：\n① 摸底\n② 出稿'],
    ['无序 - 列表', '方案：\n- 步骤甲\n- 步骤乙'],
    ['无序 * 列表', 'plan:\n* step a\n* step b'],
    ['无序 • 列表', '方案：\n• 甲\n• 乙'],
    ['标题 + 两条以上列表项', '# 实施计划\n1. 先摸底\n2. 再收口'],
    ['混合编号与圆号', '方案：\n1. 甲\n② 乙'],
  ])('结构化正文命中：%s', (_label, content) => {
    const input = makeStepInput({ response: { type: 'text', content } });
    expect(planExitFallbackStep(input)).toBe('reminded');
    expect(input.remind).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['澄清：列表项多数以问号结尾', '几个问题：\n1. 用哪个分支？\n2. 何时上线？\n3. 预算多少？'],
    ['澄清：全角问号列表', '想确认：\n- 目标是谁？\n- 范围到哪？'],
    ['澄清：末段提问且列表不足两条', '我先说一句。\n1. 仅一条\n那你要我先从哪部分开始？'],
    ['道歉/拒绝：无结构解释', '抱歉，这个问题我目前没法直接回答，需要更多上下文才能判断。'],
    ['空正文', '   \n  '],
    ['普通段落答案', '这个函数的职责是把消息按会话归档，不涉及别的东西。'],
    ['只有一条列表步骤', '方案：\n1. 只此一步'],
  ])('非计划正文不触发：%s', (_label, content) => {
    const input = makeStepInput({ response: { type: 'text', content } });
    expect(planExitFallbackStep(input)).toBe('none');
    expect(input.remind).not.toHaveBeenCalled();
    expect(input.state.spent).toBe(false);
  });

  it('围栏代码块里的编号行不算列表步骤', () => {
    const content = ['说明：', '```', '1. not a step', '2. not a step', '```'].join('\n');
    expect(planExitFallbackStep(makeStepInput({ response: { type: 'text', content } }))).toBe('none');
  });

  it('一条提问 + 一条陈述的列表不是「提问为主」，照常触发', () => {
    const content = '1. 目标是什么？\n2. 先摸清现状';
    expect(planExitFallbackStep(makeStepInput({ response: { type: 'text', content } }))).toBe('reminded');
  });
});

describe('planExitFallbackStep ① 四类响应', () => {
  it('(a) 带退出工具调用的响应：判据与预算都不动', () => {
    const input = makeStepInput({
      response: { type: 'text', content: PLAN_BODY, toolCalls: [{ id: 'c1', name: 'exit_plan_mode' }] },
    });
    expect(planExitFallbackStep(input)).toBe('none');
    expect(input.state.spent).toBe(false);
    expect(input.emitDetected).not.toHaveBeenCalled();
    expect(input.remind).not.toHaveBeenCalled();

    const toolUseInput = makeStepInput({
      response: { type: 'tool_use', content: undefined, toolCalls: [{ id: 'c1', name: 'PlanMode' }] },
    });
    expect(planExitFallbackStep(toolUseInput)).toBe('none');
    expect(toolUseInput.state.spent).toBe(false);
  });

  it('(b) 计划正文无工具：提醒一次，trace 记录结构原因与 exitToolCalled=false', () => {
    const input = makeStepInput();
    expect(planExitFallbackStep(input)).toBe('reminded');
    expect(input.emitDetected).toHaveBeenCalledWith({
      textLength: PLAN_BODY.length,
      structureReason: expect.stringContaining('list_items=3'),
      exitToolCalled: false,
      runKey: 'run-1',
    });
    const reminder = input.remind.mock.calls[0][0];
    expect(reminder).toContain('计划已识别');
    expect(reminder).toContain('exit_plan_mode');
  });

  it('(c)/(d) 澄清与拒绝不触发：见上「非计划正文不触发」参数化用例', () => {
    expect(true).toBe(true);
  });
});

describe('planExitFallbackStep 触发前提', () => {
  it('非 plan mode 会话不受影响（⑤）', () => {
    const input = makeStepInput({ planModeActive: false });
    expect(planExitFallbackStep(input)).toBe('none');
    expect(input.remind).not.toHaveBeenCalled();
  });

  it.each([
    ['已取消', { cancelled: true }],
    ['强制收尾轮', { forcedFinalPass: true }],
    ['拿不到 runKey', { runKey: undefined }],
    ['runKey 为空串', { runKey: '' }],
  ])('%s 不触发', (_label, overrides) => {
    const input = makeStepInput(overrides as Partial<StepInputWithSpies>);
    expect(planExitFallbackStep(input)).toBe('none');
  });
});

describe('planExitFallbackStep runKey 幂等（③）', () => {
  it('同一 run 第二段合格正文不再提醒，只记一次 not_applicable', () => {
    const input = makeStepInput();
    expect(planExitFallbackStep(input)).toBe('reminded');

    const second = makeStepInput({ state: input.state });
    expect(planExitFallbackStep(second)).toBe('not-applicable');
    expect(second.remind).not.toHaveBeenCalled();
    expect(second.emitNotApplicable).toHaveBeenCalledTimes(1);
    expect(second.emitNotApplicable).toHaveBeenCalledWith({
      retryCount: 1,
      runKey: 'run-1',
      textLength: PLAN_BODY.length,
    });

    // 第三段也不再记：not_applicable 每 run 只落一次
    const third = makeStepInput({ state: input.state });
    expect(planExitFallbackStep(third)).toBe('not-applicable');
    expect(third.emitNotApplicable).not.toHaveBeenCalled();
    expect(third.remind).not.toHaveBeenCalled();
  });

  it('补推理返回澄清文本也走 not-applicable（不循环、不二次提醒）', () => {
    const input = makeStepInput();
    expect(planExitFallbackStep(input)).toBe('reminded');
    const clarification = makeStepInput({
      state: input.state,
      response: { type: 'text', content: '你想先做哪一部分？' },
    });
    expect(planExitFallbackStep(clarification)).toBe('not-applicable');
    expect(clarification.remind).not.toHaveBeenCalled();
  });

  it('新 runKey 拿到新预算', () => {
    const first = makeStepInput();
    expect(planExitFallbackStep(first)).toBe('reminded');
    const nextRun = makeStepInput({ state: first.state, runKey: 'run-2' });
    expect(planExitFallbackStep(nextRun)).toBe('reminded');
    expect(nextRun.remind).toHaveBeenCalledTimes(1);
  });
});

describe('② 判据模块没有动作词/目标词词表', () => {
  const moduleSource = readFileSync(
    path.resolve(__dirname, '../../../src/host/agent/runtime/planExitFallback.ts'),
    'utf8',
  );

  it('源码不含动作词/目标词词表常量或中文动作词', () => {
    // 断言方法：直接读模块源码全文（含注释），逐个否定「会忍不住加进去」的词表形态——
    // 中文动作词、英文动作词、*WORDS 命名的词表常量、字符串数组字面量。
    expect(moduleSource).not.toMatch(/实现|部署|创建|删除|安装|修改|重构|优化|迁移/);
    expect(moduleSource).not.toMatch(/\b(?:create|install|deploy|delete|refactor|implement|migrate)\b/i);
  });

  it('源码不含 *WORDS 词表常量与字符串数组字面量', () => {
    expect(moduleSource).not.toMatch(/(?:ACTION|GOAL|VERB)[A-Z_]*WORDS/i);
    expect(moduleSource).not.toMatch(/=\s*\[\s*['"]/);
  });
});

describe('planExitFallback 写类封锁判定（④）', () => {
  const activeCtx = () => ({ control: { planExitFallbackActive: true } });
  const inactiveCtx = () => ({ control: { planExitFallbackActive: false } });
  const planOn = () => true;
  const planOff = () => false;

  it.each(['Write', 'write', 'Edit', 'Append', 'Bash'])('补推理中 %s 在 admission 层拒绝', (toolName) => {
    expect(isWriteBlockedDuringPlanExitFallback(activeCtx(), planOn, toolName)).toBe(true);
  });

  it.each(['Read', 'Grep', 'exit_plan_mode', 'PlanMode'])('%s 不在封锁名单', (toolName) => {
    expect(isWriteBlockedDuringPlanExitFallback(activeCtx(), planOn, toolName)).toBe(false);
  });

  it('旗标未置或 plan mode 已退出时不封锁', () => {
    expect(isWriteBlockedDuringPlanExitFallback(inactiveCtx(), planOn, 'Write')).toBe(false);
    expect(isWriteBlockedDuringPlanExitFallback(activeCtx(), planOff, 'Write')).toBe(false);
  });
});
