import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../../../src/shared/contract';
import type { CanUseToolFn, CanUseToolRequestHint, ToolContext } from '../../../../../src/host/protocol/tools';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../../../../src/host/mcp/cuaStateAdapter';
import {
  CuaStatefulComputerUseHandler,
  cuaStatefulComputerUseModuleFor,
} from '../../../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse';
import {
  cuaStatefulComputerUseSchema,
  withCuaJevStepOperation,
} from '../../../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.schema';
import { RunRegistry } from '../../../../../src/host/runtime/runRegistry';
import { SurfaceExecutionRuntime } from '../../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import {
  resolveCuaJevStep,
  type CuaJevStepDeps,
  type CuaJevStepDispatch,
} from '../../../../../src/host/agent/runtime/desktop/jevCuaStep';
import type { JevAnswers, JevSystemOneCall } from '../../../../../src/shared/constants/jevQuestions';
import type { TurnCostEstimateInput } from '../../../../../src/shared/contract/turnCost';

// ④ 全 mock：判官/快模型/账本/驱动都是本文件内的假件，不构造任何真实网络客户端。

type FakeAnswers = {
  mutation: { choice: string; confidence: number };
  target: { choice: string; confidence: number };
  done: { noul: number };
  risk: { noul: number };
};

interface ScriptedSystemOne {
  call: JevSystemOneCall;
  states: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  /** 置 true 后每次调用抛错（模拟判官错误）。 */
  fail: boolean;
}

function scriptedSystemOne(script: FakeAnswers[]): ScriptedSystemOne {
  const states: Array<Record<string, unknown>> = [];
  const questions: Array<Record<string, unknown>> = [];
  let round = 0;
  const systemOne: ScriptedSystemOne = {
    fail: false,
    states,
    questions,
    call: async (state, questionSpecs) => {
      if (systemOne.fail) throw new Error('typesafe down');
      states.push(JSON.parse(JSON.stringify(state)) as Record<string, unknown>);
      questions.push(JSON.parse(JSON.stringify(questionSpecs)) as Record<string, unknown>);
      const answers = script[Math.min(round, script.length - 1)] ?? script[script.length - 1];
      if (!answers) throw new Error('missing scripted answers');
      round += 1;
      return {
        mutation: answers.mutation,
        target: answers.target,
        done: answers.done,
        risk: answers.risk,
      } as JevAnswers;
    },
  };
  return systemOne;
}

const DEFAULT_ELEMENTS: Array<Record<string, unknown>> = [
  {
    element_index: 1,
    element_token: 'token-1',
    role: 'AXButton',
    label: 'Submit',
    frame: { x: 10, y: 10, w: 80, h: 20 },
    depth: 2,
  },
  {
    element_index: 2,
    element_token: 'token-2',
    role: 'AXButton',
    label: 'Done',
    frame: { x: 10, y: 40, w: 80, h: 20 },
    depth: 2,
  },
];

function buttonElement(index: number, label: string, role = 'AXButton'): Record<string, unknown> {
  return {
    element_index: index,
    element_token: `token-${index}`,
    role,
    label,
    frame: { x: 10, y: 10 + index * 10, w: 80, h: 20 },
    depth: 2,
  };
}

class LoopFakeDriver implements CuaDriverPort {
  generation = 'cua-driver:loop';
  readonly calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  windows: Array<Record<string, unknown>> = [{
    pid: 42,
    window_id: 7,
    app_name: 'Notes',
    title: 'Notes draft',
    is_on_screen: true,
    on_current_space: true,
  }];
  observations: Array<Array<Record<string, unknown>>> = [];
  actResults: CuaDriverCallResult[] = [];
  private observeCount = 0;
  private actCount = 0;

  async call(
    toolName: string,
    args: Record<string, unknown>,
    _context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    this.calls.push({ toolName, args });
    if (toolName === 'list_windows') {
      return { success: true, structured: { windows: this.windows } };
    }
    if (toolName === 'get_window_state') {
      this.observeCount += 1;
      const index = Math.min(this.observeCount - 1, Math.max(this.observations.length - 1, 0));
      const elements = this.observations.length > 0
        ? this.observations[index]!
        : DEFAULT_ELEMENTS;
      return {
        success: true,
        structured: {
          snapshot_id: `snap-${this.observeCount}`,
          screenshot_width: 200,
          screenshot_height: 100,
          elements,
        },
        screenshot: {
          data: Buffer.from(`shot-${this.observeCount}`).toString('base64'),
          mimeType: 'image/png',
        },
      };
    }
    if (toolName === 'start_session' || toolName === 'end_session') {
      return { success: true, output: 'ok' };
    }
    this.actCount += 1;
    return this.actResults[Math.min(this.actCount - 1, Math.max(this.actResults.length - 1, 0))]
      ?? { success: true, output: 'ok' };
  }

  getGeneration(): string | undefined {
    return this.generation;
  }

  get actionCalls() {
    return this.calls.filter((call) =>
      !['list_windows', 'get_window_state', 'start_session', 'end_session'].includes(call.toolName));
  }
}

let eventSeq = 0;

interface Harness {
  sessionId: string;
  runId: string;
  driver: LoopFakeDriver;
  handler: CuaStatefulComputerUseHandler;
  events: AgentEvent[];
  permissionHints: Array<{ tool: string; args: Record<string, unknown>; hint: CanUseToolRequestHint | undefined }>;
  permissionsAllowed: boolean;
  systemOne: ScriptedSystemOne;
  quickTypePrompts: string[];
  quickTypeResult: string | null;
  costRows: TurnCostEstimateInput[];
  nowMs: () => number;
}

function toolContext(source: { sessionId: string; runId: string; events: AgentEvent[] }): ToolContext {
  eventSeq += 1;
  return {
    runId: source.runId,
    turnId: `turn-${eventSeq}`,
    sessionId: source.sessionId,
    workspace: process.cwd(),
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    agentId: 'agent-a',
    currentToolCallId: `tool-${eventSeq}`,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    emit(event) {
      source.events.push(event);
    },
  };
}

function createHarness(input: {
  sessionId: string;
  script: FakeAnswers[];
  observations?: Array<Array<Record<string, unknown>>>;
  windows?: Array<Record<string, unknown>>;
  actResults?: CuaDriverCallResult[];
}): Harness {
  const driver = new LoopFakeDriver();
  if (input.windows) driver.windows = input.windows;
  if (input.observations) driver.observations = input.observations;
  if (input.actResults) driver.actResults = input.actResults;
  const registry = new RunRegistry();
  registry.start({ runId: `run-${input.sessionId}`, sessionId: input.sessionId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const systemOne = scriptedSystemOne(input.script);
  const harness: Harness = {
    sessionId: input.sessionId,
    runId: `run-${input.sessionId}`,
    driver,
    events: [],
    permissionHints: [],
    permissionsAllowed: true,
    systemOne,
    quickTypePrompts: [],
    quickTypeResult: 'quick value',
    costRows: [],
    nowMs: () => Date.now(),
    handler: null!,
  };
  const quickType = async (prompt: string) => {
    harness.quickTypePrompts.push(prompt);
    return harness.quickTypeResult;
  };
  const recordCost = (row: TurnCostEstimateInput) => {
    harness.costRows.push(row);
  };
  const deps: CuaJevStepDeps = {
    systemOne: systemOne.call,
    quickType,
    recordCost,
    now: () => harness.nowMs(),
  };
  const factory = (dispatch: CuaJevStepDispatch) => resolveCuaJevStep(dispatch, deps);
  harness.handler = new CuaStatefulComputerUseHandler(
    new CuaStateAdapter(driver),
    runtime,
    factory,
  );
  return harness;
}

function canUseToolFor(harness: Harness): CanUseToolFn {
  return async (tool, args, _reason, hint) => {
    harness.permissionHints.push({ tool, args, hint });
    return harness.permissionsAllowed ? { allow: true } : { allow: false, reason: 'denied by test' };
  };
}

const ENV_FLAG = 'CODE_AGENT_CUA_JEV_STEP';
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[ENV_FLAG];
  process.env[ENV_FLAG] = '1';
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[ENV_FLAG];
  else process.env[ENV_FLAG] = savedFlag;
});

const STOP_DONE: FakeAnswers = {
  mutation: { choice: 'stop', confidence: 0.9 },
  target: { choice: 'no_target', confidence: 0.9 },
  done: { noul: 0.95 },
  risk: { noul: 0.1 },
};

function clickAnswers(ref: string, riskNoul = 0.1): FakeAnswers {
  return {
    mutation: { choice: 'click', confidence: 0.9 },
    target: { choice: ref, confidence: 0.9 },
    done: { noul: 0.1 },
    risk: { noul: riskNoul },
  };
}

describe('cua execute_goal happy path', () => {
  it('clicks via elementRef, reuses the act successor as the next state, then stops on its own evidence', async () => {
    const harness = createHarness({
      sessionId: 'conv-happy',
      script: [clickAnswers('e1'), STOP_DONE],
      observations: [[buttonElement(1, 'Submit'), buttonElement(2, 'Done')]],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'click Submit in Notes' },
      ctx,
      canUseToolFor(harness),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const payload = JSON.parse(result.output) as {
      result: { status: string; steps: number; jev_calls: number; done_signals: number };
    };
    expect(payload.result.status).toBe('done_verified');
    expect(payload.result.steps).toBe(1);
    expect(payload.result.jev_calls).toBe(2);
    expect(payload.result.done_signals).toBe(1);

    // act 只有一次，走 handler 审批（②低风险也不跳过）
    expect(harness.permissionHints).toHaveLength(1);
    expect(harness.permissionHints[0]?.hint).toMatchObject({ type: 'dangerous_command' });
    expect(harness.permissionHints[0]?.hint).not.toHaveProperty('forceConfirm');

    // ① 生产 act 无 point：element_token + 显式 background，无 x/y/screenshotId
    const act = harness.driver.actionCalls[0]!;
    expect(act.toolName).toBe('click');
    expect(act.args).toMatchObject({ pid: 42, window_id: 7, element_token: 'token-1', delivery_mode: 'background' });
    expect(act.args).not.toHaveProperty('x');
    expect(act.args).not.toHaveProperty('y');

    // ⑧ successor 即下一步 state：初始 observe 1 次 + act 内部 1 次，环没有额外 observe
    const observes = harness.driver.calls.filter((call) => call.toolName === 'get_window_state');
    expect(observes).toHaveLength(2);

    // 每次决断一行刊例账：typesafe / JEV_MODEL / output 0 / usd>0 / 非 catalog
    expect(harness.costRows).toHaveLength(2);
    for (const row of harness.costRows) {
      expect(row.provider).toBe('typesafe');
      expect(row.modelId).toBe('jev-1.13.0');
      expect(row.outputTokens).toBe(0);
      expect(row.source).not.toBe('catalog');
      expect(row.usd ?? 0).toBeGreaterThan(0);
      expect(row.inputTokens).toBeGreaterThan(0);
    }
  });

  it('① rows sent to systemOne carry no value/frame and the mutation set has no coordinate channel', async () => {
    const harness = createHarness({ sessionId: 'conv-shape', script: [STOP_DONE] });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'inspect the Notes shape' },
      ctx,
      canUseToolFor(harness),
    );
    expect(result.ok).toBe(true);

    expect(harness.systemOne.states).toHaveLength(1);
    const state = harness.systemOne.states[0]!;
    const targets = state.targets as Record<string, Record<string, unknown>>;
    expect(Object.keys(targets)).toEqual(['e1', 'e2']);
    for (const row of Object.values(targets)) {
      expect(row).not.toHaveProperty('value');
      expect(row).not.toHaveProperty('frame');
      expect(row).not.toHaveProperty('point');
      expect(typeof row.has_value).toBe('boolean');
      expect(typeof row.role).toBe('string');
    }
    expect(state.flags).toEqual({ sensitive_fields_present: false });

    const mutationCriteria = Object.keys(
      (harness.systemOne.questions[0]?.mutation as { criteria: Record<string, string> }).criteria,
    );
    expect(mutationCriteria).toEqual([
      'click', 'double_click', 'set_value', 'type_text',
      'scroll_up', 'scroll_down', 'scroll_left', 'scroll_right',
      'press_return', 'press_tab', 'press_escape', 'stop',
    ]);
    expect(mutationCriteria).not.toContain('right_click');
    expect(mutationCriteria).not.toContain('hotkey');
    expect(mutationCriteria).not.toContain('drag');
    const targetCriteria = Object.keys(
      (harness.systemOne.questions[0]?.target as { criteria: Record<string, string> }).criteria,
    );
    expect(targetCriteria).toEqual(['e1', 'e2', 'no_target']);
  });
});

describe('cua execute_goal hand-backs', () => {
  it('empty AX tree hands back the observe+screenshot with reason empty_ax and zero judge/quick calls', async () => {
    const harness = createHarness({
      sessionId: 'conv-empty',
      script: [STOP_DONE],
      observations: [[]],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'do anything in Notes' },
      ctx,
      canUseToolFor(harness),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const payload = JSON.parse(result.output) as {
      result: { status: string; reason: string; observe: { stateId: string } };
    };
    expect(payload.result.status).toBe('fallback');
    expect(payload.result.reason).toBe('empty_ax');
    expect(payload.result.observe.stateId).toBeTruthy();
    expect(harness.systemOne.states).toHaveLength(0);
    expect(harness.quickTypePrompts).toHaveLength(0);
    expect(harness.driver.actionCalls).toHaveLength(0);
    // 截图随交回给主模型（point 路径要 screenshotId）
    const meta = result.meta as Record<string, unknown>;
    expect(typeof meta.imageBase64).toBe('string');
    expect(meta.computerUseStateV1).toMatchObject({ stateId: payload.result.observe.stateId });
  });

  it('filtered-empty-but-raw-nonempty hands back without authorizing any click', async () => {
    const harness = createHarness({
      sessionId: 'conv-filtered',
      script: [STOP_DONE],
      observations: [[
        buttonElement(1, 'Password', 'AXSecureTextField'),
        buttonElement(2, 'upload', 'AXFileUploadButton'),
      ]],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'sign in to Notes' },
      ctx,
      canUseToolFor(harness),
    );

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { status: string; reason: string };
    };
    expect(payload.result.status).toBe('fallback');
    expect(payload.result.reason).toBe('no_candidates');
    expect(harness.systemOne.states).toHaveLength(0);
    expect(harness.driver.actionCalls).toHaveLength(0);
  });

  it('ambiguous root selection hands back with the roots listed', async () => {
    const harness = createHarness({
      sessionId: 'conv-roots',
      script: [STOP_DONE],
      windows: [
        { pid: 42, window_id: 7, app_name: 'Notes', title: 'draft', is_on_screen: true, on_current_space: true },
        { pid: 43, window_id: 8, app_name: 'Notes', title: 'meeting notes', is_on_screen: true, on_current_space: true },
      ],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'edit the Notes draft' },
      ctx,
      canUseToolFor(harness),
    );

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string; roots: Array<{ pid: number }> };
    };
    expect(payload.result.reason).toBe('root_ambiguous');
    expect(payload.result.roots.map((root) => root.pid)).toEqual([42, 43]);
    expect(harness.systemOne.states).toHaveLength(0);
  });

  it('budget: first estimate already over budget stops with zero judge calls', async () => {
    const harness = createHarness({ sessionId: 'conv-budget', script: [STOP_DONE] });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'budgeted Notes task', jevBudgetUsd: 1e-9 },
      ctx,
      canUseToolFor(harness),
    );

    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string };
    };
    expect(payload.result.reason).toBe('budget');
    expect(harness.systemOne.states).toHaveLength(0);
    expect(harness.costRows).toHaveLength(0);
  });

  it('jev error falls back to the main-model flow and stays sticky for the task', async () => {
    const errorHarness = createHarness({ sessionId: 'conv-sticky', script: [STOP_DONE] });
    errorHarness.systemOne.fail = true;
    const first = await errorHarness.handler.execute(
      { operation: 'execute_goal', task: 'sticky Notes task' },
      toolContext(errorHarness),
      canUseToolFor(errorHarness),
    );
    expect(first.ok).toBe(true);
    const firstPayload = JSON.parse(first.ok ? first.output : first.error) as {
      result: { reason: string };
    };
    expect(firstPayload.result.reason).toBe('jev_error');

    const second = await errorHarness.handler.execute(
      { operation: 'execute_goal', task: 'sticky Notes task' },
      toolContext(errorHarness),
      canUseToolFor(errorHarness),
    );
    const secondPayload = JSON.parse(second.ok ? second.output : second.error) as {
      result: { reason: string };
    };
    expect(secondPayload.result.reason).toBe('sticky');

    // 换任务不粘：同 session 另一个 task 重新装配
    const otherTask = await errorHarness.handler.execute(
      { operation: 'execute_goal', task: 'a different Notes task' },
      toolContext(errorHarness),
      canUseToolFor(errorHarness),
    );
    const otherPayload = JSON.parse(otherTask.ok ? otherTask.output : otherTask.error) as {
      result: { reason: string };
    };
    expect(otherPayload.result.reason).toBe('jev_error');
  });

  it('a scroll with no_target hands back instead of dispatching an element-less mutation', async () => {
    const harness = createHarness({
      sessionId: 'conv-scrollnotarget',
      script: [{
        mutation: { choice: 'scroll_down', confidence: 0.9 },
        target: { choice: 'no_target', confidence: 0.9 },
        done: { noul: 0.1 },
        risk: { noul: 0.1 },
      }],
    });
    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'scroll Notes without a container' },
      toolContext(harness),
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string };
    };
    expect(payload.result.reason).toBe('incompatible_target');
    expect(harness.driver.actionCalls).toHaveLength(0);
  });

  it('low confidence falls back before any act or approval', async () => {
    const lowConfHarness = createHarness({
      sessionId: 'conv-lowconf',
      script: [{
        mutation: { choice: 'click', confidence: 0.5 },
        target: { choice: 'e1', confidence: 0.9 },
        done: { noul: 0.1 },
        risk: { noul: 0.1 },
      }],
    });
    const lowConfResult = await lowConfHarness.handler.execute(
      { operation: 'execute_goal', task: 'low confidence Notes task' },
      toolContext(lowConfHarness),
      canUseToolFor(lowConfHarness),
    );
    const lowConfPayload = JSON.parse(lowConfResult.ok ? lowConfResult.output : lowConfResult.error) as {
      result: { reason: string; observe?: unknown };
    };
    expect(lowConfPayload.result.reason).toBe('low_confidence');
    // ③ 交回后主模型能自己 observe+act：交回载荷带 observe 证据
    expect(lowConfPayload.result.observe).toBeTruthy();
    expect(lowConfHarness.driver.actionCalls).toHaveLength(0);
    expect(lowConfHarness.permissionHints).toHaveLength(0);
  });

  it('stop without a done signal is not a termination; done alone never terminates either', async () => {
    // stop 但 done 不足 → stop_unverified 交回
    const stopOnly = createHarness({
      sessionId: 'conv-stop',
      script: [{
        mutation: { choice: 'stop', confidence: 0.9 },
        target: { choice: 'no_target', confidence: 0.9 },
        done: { noul: 0.2 },
        risk: { noul: 0.1 },
      }],
    });
    const stopOnlyResult = await stopOnly.handler.execute(
      { operation: 'execute_goal', task: 'stop in Notes without evidence' },
      toolContext(stopOnly),
      canUseToolFor(stopOnly),
    );
    const stopOnlyPayload = JSON.parse(stopOnlyResult.ok ? stopOnlyResult.output : stopOnlyResult.error) as {
      result: { status: string; reason: string };
    };
    expect(stopOnlyPayload.result.status).toBe('fallback');
    expect(stopOnlyPayload.result.reason).toBe('stop_unverified');
    expect(stopOnly.driver.actionCalls).toHaveLength(0);

    // done=1.0 但 mutation=click：不终止，继续 act 直到撞步顶（反向变异 ⑤(a) 的常态断言）
    const doneOnly = createHarness({
      sessionId: 'conv-done1',
      script: [
        {
          mutation: { choice: 'click', confidence: 0.9 },
          target: { choice: 'e1', confidence: 0.9 },
          done: { noul: 1.0 },
          risk: { noul: 0.1 },
        },
        clickAnswers('e2'),
      ],
    });
    const doneOnlyResult = await doneOnly.handler.execute(
      { operation: 'execute_goal', task: 'Notes done forced high' },
      toolContext(doneOnly),
      canUseToolFor(doneOnly),
    );
    expect(doneOnly.driver.actionCalls.length).toBeGreaterThanOrEqual(2);
    const doneOnlyPayload = JSON.parse(doneOnlyResult.ok ? doneOnlyResult.output : doneOnlyResult.error) as {
      result: { status: string; done_signals: number };
    };
    expect(doneOnlyPayload.result.done_signals).toBe(1);
    expect(doneOnlyPayload.result.status).toBe('step_limit');
  });
});

describe('cua execute_goal safety', () => {
  it('② raises the existing approval for every act and only upgrades to forceConfirm on risk', async () => {
    const harness = createHarness({
      sessionId: 'conv-risk',
      script: [
        clickAnswers('e1', 0.1),
        // 风险词走标签通道：label 命中 delete 语义 + 低 noul risk
        {
          mutation: { choice: 'click', confidence: 0.9 },
          target: { choice: 'e2', confidence: 0.9 },
          done: { noul: 0.1 },
          risk: { noul: 0.1 },
        },
        STOP_DONE,
      ],
      observations: [[
        buttonElement(1, 'Compose'),
        buttonElement(2, 'Delete everything'),
      ]],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'compose in Notes then clean up' },
      ctx,
      canUseToolFor(harness),
    );
    expect(result.ok).toBe(true);

    // 两次 act 两次审批：低风险那次也不跳过；只有风险那次 forceConfirm
    expect(harness.permissionHints).toHaveLength(2);
    expect(harness.permissionHints[0]?.hint).not.toHaveProperty('forceConfirm');
    expect(harness.permissionHints[1]?.hint).toMatchObject({ forceConfirm: true });
    expect(harness.permissionHints.map((entry) => entry.tool)).toEqual(['computer_use', 'computer_use']);
  });

  it('② a denied approval stops the loop with needs_review instead of acting anyway', async () => {
    const harness = createHarness({ sessionId: 'conv-deny', script: [clickAnswers('e1')] });
    harness.permissionsAllowed = false;
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'click submit in Notes' },
      ctx,
      canUseToolFor(harness),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected denial');
    expect(result.code).toBe('SURFACE_APPROVAL_REQUIRED');
    expect(harness.driver.actionCalls).toHaveLength(0);
    const payload = JSON.parse(result.error) as { result: { status: string } };
    expect(payload.result.status).toBe('needs_review');
  });

  it('maps press_return to a bare background press_key without any element or point', async () => {
    const harness = createHarness({
      sessionId: 'conv-press',
      script: [
        {
          mutation: { choice: 'press_return', confidence: 0.9 },
          target: { choice: 'no_target', confidence: 0.9 },
          done: { noul: 0.1 },
          risk: { noul: 0.1 },
        },
        STOP_DONE,
      ],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'press return in Notes' },
      ctx,
      canUseToolFor(harness),
    );
    expect(result.ok).toBe(true);

    const act = harness.driver.actionCalls[0]!;
    expect(act.toolName).toBe('press_key');
    expect(act.args).toMatchObject({ key: 'return', delivery_mode: 'background', pid: 42, window_id: 7 });
    expect(act.args).not.toHaveProperty('element_token');
    expect(act.args).not.toHaveProperty('x');
  });

  it('type_text value comes from quickTask with a prompt free of AX values', async () => {
    const harness = createHarness({
      sessionId: 'conv-type',
      script: [
        {
          mutation: { choice: 'type_text', confidence: 0.9 },
          target: { choice: 'e1', confidence: 0.9 },
          done: { noul: 0.1 },
          risk: { noul: 0.1 },
        },
        STOP_DONE,
      ],
      observations: [[
        { ...buttonElement(1, 'Search'), role: 'AXTextField', value: 'stale ax value' },
        buttonElement(2, 'Done'),
      ]],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'search Notes for the quarterly report' },
      ctx,
      canUseToolFor(harness),
    );
    expect(result.ok).toBe(true);

    expect(harness.quickTypePrompts).toHaveLength(1);
    expect(harness.quickTypePrompts[0]).toContain('quarterly report');
    expect(harness.quickTypePrompts[0]).toContain('Search');
    expect(harness.quickTypePrompts[0]).not.toContain('stale ax value');
    const act = harness.driver.actionCalls[0]!;
    expect(act.toolName).toBe('type_text');
    expect(act.args).toMatchObject({ text: 'quick value', element_token: 'token-1', delivery_mode: 'background' });
    expect(act.args).not.toHaveProperty('value');
  });

  it('a failed quick model hands back instead of slicing the task text into the field', async () => {
    const harness = createHarness({
      sessionId: 'conv-quickfail',
      script: [
        {
          mutation: { choice: 'set_value', confidence: 0.9 },
          target: { choice: 'e1', confidence: 0.9 },
          done: { noul: 0.1 },
          risk: { noul: 0.1 },
        },
        STOP_DONE,
      ],
      observations: [[
        { ...buttonElement(1, 'Title'), role: 'AXTextField', value: 'old' },
        buttonElement(2, 'Done'),
      ]],
    });
    harness.quickTypeResult = null;
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'rename the Notes title' },
      ctx,
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string };
    };
    expect(payload.result.reason).toBe('type_value_unavailable');
    expect(harness.driver.actionCalls).toHaveLength(0);
  });
});

describe('cua execute_goal stale/focus/verification hand-backs', () => {
  it('stale token errors hand back without retrying the same stateId', async () => {
    const harness = createHarness({
      sessionId: 'conv-stale',
      script: [clickAnswers('e1')],
      actResults: [{ success: false, error: 'element_token is stale; snapshot superseded' }],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'click submit in Notes' },
      ctx,
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string };
    };
    expect(payload.result.reason).toBe('stale_state');
    expect(harness.driver.actionCalls).toHaveLength(1);
  });

  it('focus-stolen driver errors hand back and never retry in foreground', async () => {
    const harness = createHarness({
      sessionId: 'conv-focus',
      script: [clickAnswers('e1')],
      actResults: [{ success: false, error: 'Action caused a different app to become frontmost.' }],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'click submit in Notes' },
      ctx,
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string };
    };
    expect(payload.result.reason).toBe('focus_stolen');
    expect(harness.driver.actionCalls).toHaveLength(1);
    for (const call of harness.driver.actionCalls) {
      expect(call.args.delivery_mode).not.toBe('foreground');
    }
  });

  it('ambiguous delivery (unverifiable) hands back instead of counting as success', async () => {
    const harness = createHarness({
      sessionId: 'conv-ambiguous',
      script: [clickAnswers('e1')],
      actResults: [{ success: false, error: 'request timed out' }],
    });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'click submit in Notes' },
      ctx,
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { reason: string };
    };
    expect(payload.result.reason).toBe('delivery_unverified');
  });
});

describe('cua execute_goal limits', () => {
  it('soft step limit caps the loop at 20 jev steps', async () => {
    const scroll: FakeAnswers = {
      mutation: { choice: 'scroll_down', confidence: 0.9 },
      target: { choice: 'e1', confidence: 0.9 },
      done: { noul: 0.1 },
      risk: { noul: 0.1 },
    };
    const harness = createHarness({ sessionId: 'conv-steplimit', script: [scroll] });
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'scroll Notes forever' },
      ctx,
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { status: string; steps: number; jev_calls: number };
    };
    expect(payload.result.status).toBe('step_limit');
    expect(payload.result.steps).toBe(20);
    expect(payload.result.jev_calls).toBe(20);
  });

  it('wall clock limit stops the loop', async () => {
    const scroll: FakeAnswers = {
      mutation: { choice: 'scroll_up', confidence: 0.9 },
      target: { choice: 'e2', confidence: 0.9 },
      done: { noul: 0.1 },
      risk: { noul: 0.1 },
    };
    const harness = createHarness({ sessionId: 'conv-timelimit', script: [scroll] });
    let ticks = 0;
    harness.nowMs = () => {
      ticks += 1;
      return ticks * 45_000;
    };
    const ctx = toolContext(harness);

    const result = await harness.handler.execute(
      { operation: 'execute_goal', task: 'scroll Notes until the clock bites' },
      ctx,
      canUseToolFor(harness),
    );
    const payload = JSON.parse(result.ok ? result.output : result.error) as {
      result: { status: string };
    };
    expect(payload.result.status).toBe('time_limit');
    expect(harness.systemOne.states.length).toBeLessThan(20);
  });
});

describe('cua execute_goal arming and schema', () => {
  it("③ unarmed flag: execute_goal answers unarmed and today's three operations still parse", async () => {
    delete process.env[ENV_FLAG];
    const registry = new RunRegistry();
    registry.start({ runId: 'run-conv-unarmed', sessionId: 'conv-unarmed', workspace: process.cwd() });
    const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
    const handler = new CuaStatefulComputerUseHandler(
      new CuaStateAdapter(new LoopFakeDriver()),
      runtime,
    );
    const events: AgentEvent[] = [];
    const result = await handler.execute(
      { operation: 'execute_goal', task: 'anything' },
      toolContext({ sessionId: 'conv-unarmed', runId: 'run-conv-unarmed', events }),
      async () => ({ allow: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected unarmed');
    expect(result.code).toBe('CUA_JEV_STEP_UNARMED');
  });

  it('③ no key: resolveCuaJevStep stays unarmed when no route resolves', () => {
    expect(resolveCuaJevStep(async () => ({ ok: true, output: '' }), { keyRoute: () => null })).toBeUndefined();
  });

  it('schema with the flag off is byte-identical to the static schema', () => {
    const transformed = withCuaJevStepOperation(cuaStatefulComputerUseSchema, {});
    expect(JSON.stringify(transformed)).toBe(JSON.stringify(cuaStatefulComputerUseSchema));
    expect(cuaStatefulComputerUseModuleFor(false).schema).toBe(cuaStatefulComputerUseSchema);
  });

  it('schema with the flag on gains execute_goal plus its params at the enum tail', () => {
    const transformed = withCuaJevStepOperation(cuaStatefulComputerUseSchema, { CODE_AGENT_CUA_JEV_STEP: '1' });
    const operation = transformed.inputSchema.properties?.operation as { enum: string[] };
    expect(operation.enum).toEqual(['list_roots', 'observe', 'act', 'execute_goal']);
    const properties = transformed.inputSchema.properties as Record<string, unknown>;
    expect(properties.task).toMatchObject({ type: 'string' });
    expect(properties.jevBudgetUsd).toMatchObject({ type: 'number' });
    expect(transformed.description).toContain('execute_goal');
    // 原有字段不丢
    expect(properties.stateId).toBeTruthy();
    expect(properties.mutation).toBeTruthy();
    expect(properties.target).toBeTruthy();
    expect(cuaStatefulComputerUseModuleFor(true).schema.description).toContain('execute_goal');
  });
});
