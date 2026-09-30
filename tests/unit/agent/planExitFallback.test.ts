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
import { settlePlanExitFallbackOnTextBreak } from '../../../src/host/agent/runtime/planExitFallbackCard';
import { executeExitPlanMode } from '../../../src/host/tools/modules/planning/exitPlanMode';
import type { ToolContext } from '../../../src/host/protocol/tools';
import type { Message } from '../../../src/shared/contract';

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

describe('planExitFallbackStep runKey 幂等（③）与 K2 合成判定', () => {
  it('同一 run 第二段合格正文不再提醒，改判 synthesize（ADR-074 K2：宿主合成审批卡）', () => {
    const input = makeStepInput();
    expect(planExitFallbackStep(input)).toBe('reminded');

    const second = makeStepInput({ state: input.state });
    expect(planExitFallbackStep(second)).toBe('synthesize');
    expect(second.remind).not.toHaveBeenCalled();
    expect(second.emitNotApplicable).not.toHaveBeenCalled();
    expect(second.state.synthesized).toBe(true);

    // 每 run 至多合成一次：合成后再来的正文回落 not_applicable，且只记一次
    const third = makeStepInput({ state: input.state });
    expect(planExitFallbackStep(third)).toBe('not-applicable');
    expect(third.emitNotApplicable).toHaveBeenCalledTimes(1);
    expect(third.emitNotApplicable).toHaveBeenCalledWith({
      retryCount: 1,
      runKey: 'run-1',
      textLength: PLAN_BODY.length,
    });

    const fourth = makeStepInput({ state: input.state });
    expect(planExitFallbackStep(fourth)).toBe('not-applicable');
    expect(fourth.emitNotApplicable).not.toHaveBeenCalled();
    expect(fourth.remind).not.toHaveBeenCalled();
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

describe('planExitFallback 写类封锁判定（④，K2 扩为 allowlist）', () => {
  // 只读 Bash 判定走真 detector 成员：grep/ls/cat 开头算只读，其余（npm install、rm）算写。
  const activeCtx = () => ({
    control: { planExitFallbackActive: true },
    antiPatternDetector: { isReadOnlyShellCommand: (command: string) => /^(grep|ls|cat)\b/.test(command) },
  });
  const inactiveCtx = () => ({ control: { planExitFallbackActive: false }, antiPatternDetector: activeCtx().antiPatternDetector });
  const planOn = () => true;
  const planOff = () => false;
  const call = (name: string, command?: string) => ({ name, arguments: command === undefined ? {} : { command } });

  it.each([
    ['Write', call('Write')],
    ['小写 write', call('write')],
    ['Edit', call('Edit')],
    ['Append', call('Append')],
    ['写文件型 Bash', call('Bash', 'npm install left-pad')],
    ['删目录 Bash', call('Bash', 'rm -rf /tmp/x')],
    ['MCP 未知工具（fail closed）', call('mcp__github__create_issue')],
    ['MCP 写工具', call('mcp__fs__write_file')],
    ['连接器写工具', call('mail')],
    ['子代理 spawn', call('spawn_agent')],
    ['Task 子代理', call('Task')],
    ['产物生成器', call('ppt_generate')],
  ])('补推理中 %s 在 admission 层拒绝', (_label, toolCall) => {
    expect(isWriteBlockedDuringPlanExitFallback(activeCtx(), planOn, toolCall)).toBe(true);
  });

  it.each([
    ['Read', call('Read')],
    ['Grep', call('Grep')],
    ['只读 Bash', call('Bash', 'grep -r foo src/')],
    ['只读 bash 小写', call('bash', 'ls -la')],
    ['退出工具 exit_plan_mode', call('exit_plan_mode')],
    ['退出工具 PlanMode', call('PlanMode')],
    ['提问工具 AskUserQuestion', call('AskUserQuestion')],
  ])('%s 放行', (_label, toolCall) => {
    expect(isWriteBlockedDuringPlanExitFallback(activeCtx(), planOn, toolCall)).toBe(false);
  });

  it('旗标未置或 plan mode 已退出时不封锁', () => {
    expect(isWriteBlockedDuringPlanExitFallback(inactiveCtx(), planOn, { name: 'Write', arguments: {} })).toBe(false);
    expect(isWriteBlockedDuringPlanExitFallback(activeCtx(), planOff, { name: 'Write', arguments: {} })).toBe(false);
  });
});

describe('settlePlanExitFallbackOnTextBreak 合成卡（K2）', () => {
  const PLAN = '方案：\n1. 甲\n2. 乙';

  type SettleInput = Parameters<typeof settlePlanExitFallbackOnTextBreak>[0];

  function makeSettleDeps(autoApprovePlan = false) {
    const persisted: Message[] = [];
    const record = vi.fn();
    const onEvent = vi.fn();
    const input = {
      ctx: {
        control: { isCancelled: false, activatePlanExitFallback: vi.fn() },
        autoApprovePlan,
        onEvent,
        turnTrace: { record },
      },
      assembly: {
        addAndPersistMessage: async (message: Message) => { persisted.push(message); },
        generateId: () => 'msg-card-1',
      },
      remind: vi.fn(),
    } as unknown as SettleInput;
    return { input, persisted, record, onEvent };
  }

  /** 预算已花（首轮已提醒）的 state：一次调用直达 synthesize 分支。 */
  const spentState = () => ({ ...createPlanExitFallbackState(), runKey: 'run-7', spent: true });

  const settleOver = (input: SettleInput, content: string, state = spentState()) => settlePlanExitFallbackOnTextBreak({
    ...input,
    state,
    response: { type: 'text', content },
    planModeActive: true,
    forcedFinalPass: false,
    runKey: 'run-7',
  });

  async function modelExitResult(plan: string): Promise<{ output: string; meta: Record<string, unknown> }> {
    const ctx = {
      sessionId: 's',
      workingDir: '/tmp',
      abortSignal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: vi.fn(),
      planMode: { isActive: () => true, enter: vi.fn(), exit: vi.fn() },
    } as unknown as ToolContext;
    const result = await executeExitPlanMode({ plan }, ctx, async () => ({ allow: true }));
    if (!result.ok) throw new Error('model exit failed');
    return { output: result.output, meta: result.meta as Record<string, unknown> };
  }

  it('落卡与 executeExitPlanMode 同形（output/metadata/steps 全套），source=synthetic_text', async () => {
    const { input, persisted, record, onEvent } = makeSettleDeps();
    const state = spentState();

    await expect(settleOver(input, PLAN, state)).resolves.toBe('synthesize');

    expect(persisted).toHaveLength(1);
    const cardMessage = persisted[0];
    expect(cardMessage.role).toBe('assistant');
    expect(cardMessage.content).toBe('');
    const toolCall = cardMessage.toolCalls![0];
    const result = toolCall.result!;
    const modelExit = await modelExitResult(PLAN);
    expect(toolCall.id).toBe('synthetic-plan-run-7');
    expect(toolCall.name).toBe('exit_plan_mode');
    expect(toolCall.arguments).toEqual({ plan: PLAN });
    expect(result.toolCallId).toBe('synthetic-plan-run-7');
    expect(result.success).toBe(true);
    expect(result.output).toBe(modelExit.output);
    expect(result.metadata?.requiresUserConfirmation).toBe(modelExit.meta.requiresUserConfirmation);
    expect(result.metadata?.confirmationType).toBe(modelExit.meta.confirmationType);
    expect(result.metadata?.plan).toBe(PLAN);
    const approval = result.metadata?.planApproval as Record<string, unknown>;
    const modelApproval = modelExit.meta.planApproval as Record<string, unknown>;
    // 键集完全一致（source 两边都带），差别只有 source 的取值
    expect(Object.keys(approval).sort()).toEqual(Object.keys(modelApproval).sort());
    expect(approval.source).toBe('synthetic_text');
    expect(modelApproval.source).toBe('model_exit');
    expect(approval.steps).toEqual(modelApproval.steps);
    expect(approval.originalPlan).toBe(PLAN);
    // trace + message 事件
    expect(record).toHaveBeenCalledWith('plan_exit_fallback_synthesized', {
      runKey: 'run-7',
      retryCount: 1,
      cardId: 'synthetic-plan-run-7',
      source: 'synthetic_text',
      textLength: PLAN.length,
    });
    expect(onEvent).toHaveBeenCalledWith({ type: 'message', data: cardMessage });
    // 合成后同 run 再来的结构化正文不再合成（每 run 至多一张）
    await expect(settleOver(input, PLAN, state)).resolves.toBe('not-applicable');
    expect(persisted).toHaveLength(1);
  });

  it('正文逐字保留：CJK、代码围栏、行尾换行', async () => {
    const body = '方案如下：\n1. 先读 `a.ts`\n2. 再跑：\n```bash\nnpm test\n```\n';
    const { input, persisted } = makeSettleDeps();
    await expect(settleOver(input, body)).resolves.toBe('synthesize');
    const result = persisted[0].toolCalls![0].result!;
    expect(result.metadata?.plan).toBe(body);
    expect((result.metadata?.planApproval as { originalPlan: string }).originalPlan).toBe(body);
  });

  it('autoApprovePlan=true：不落卡、不记 synthesized trace（维持今日语义）', async () => {
    const { input, persisted, record, onEvent } = makeSettleDeps(true);
    await expect(settleOver(input, PLAN)).resolves.toBe('synthesize');
    expect(persisted).toHaveLength(0);
    expect(record).not.toHaveBeenCalledWith('plan_exit_fallback_synthesized', expect.anything());
    expect(onEvent).not.toHaveBeenCalled();
  });
});
