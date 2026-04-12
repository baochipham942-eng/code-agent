// ============================================================================
// ExitPlanMode (native ToolModule) Tests — P0-6.3 Batch B1
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
  PlanModeController,
  AgentEvent,
} from '../../../../../src/main/protocol/tools';
import {
  exitPlanModeModule,
  PLAN_CONFIRMATION_TYPE,
} from '../../../../../src/main/tools/migrated/planning/exitPlanMode';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface FakePlanMode extends PlanModeController {
  _active: boolean;
  enterCalls: Array<string | undefined>;
  exitCalls: Array<string | undefined>;
}

function makeFakePlanMode(): FakePlanMode {
  const state: FakePlanMode = {
    _active: true,
    enterCalls: [],
    exitCalls: [],
    isActive: () => state._active,
    enter: (reason?: string) => {
      state._active = true;
      state.enterCalls.push(reason);
    },
    exit: (reason?: string) => {
      state._active = false;
      state.exitCalls.push(reason);
    },
  };
  return state;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    planMode: makeFakePlanMode(),
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await exitPlanModeModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const SAMPLE_PLAN = `## Plan\n1. step one\n2. step two`;

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('exitPlanModeModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(exitPlanModeModule.schema.name).toBe('exit_plan_mode');
      expect(exitPlanModeModule.schema.category).toBe('planning');
      expect(exitPlanModeModule.schema.permissionLevel).toBe('write');
      expect(exitPlanModeModule.schema.allowInPlanMode).toBe(true);
      expect(exitPlanModeModule.schema.inputSchema.required).toContain('plan');
    });
  });

  describe('execution', () => {
    it('deactivates plan mode via ctx.planMode.exit()', async () => {
      const planMode = makeFakePlanMode();
      const ctx = makeCtx({ planMode });
      const result = await run({ plan: SAMPLE_PLAN }, ctx);
      expect(result.ok).toBe(true);
      expect(planMode._active).toBe(false);
      expect(planMode.exitCalls.length).toBe(1);
    });

    it('includes plan text and confirmation options in output', async () => {
      const result = await run({ plan: SAMPLE_PLAN });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain(SAMPLE_PLAN);
        expect(result.output).toContain('实现计划');
        expect(result.output).toContain('确认执行');
        expect(result.output).toContain('修改计划');
        expect(result.output).toContain('取消');
      }
    });

    it('sets meta.requiresUserConfirmation and plan', async () => {
      const result = await run({ plan: SAMPLE_PLAN });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta?.requiresUserConfirmation).toBe(true);
        expect(result.meta?.confirmationType).toBe(PLAN_CONFIRMATION_TYPE);
        expect(result.meta?.plan).toBe(SAMPLE_PLAN);
      }
    });

    it('emits plan_mode_exited AgentEvent with plan', async () => {
      const emit = vi.fn<[AgentEvent], void>();
      const ctx = makeCtx({ emit });
      await run({ plan: SAMPLE_PLAN }, ctx);
      expect(emit).toHaveBeenCalledTimes(1);
      const ev = emit.mock.calls[0][0];
      expect(ev.type).toBe('plan_mode_exited');
      expect((ev as { data: { plan: string } }).data.plan).toBe(SAMPLE_PLAN);
    });

    it('emits onProgress events', async () => {
      const onProgress = vi.fn();
      await run({ plan: SAMPLE_PLAN }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });

  describe('validation & errors', () => {
    it('rejects missing plan', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty plan', async () => {
      const result = await run({ plan: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects whitespace-only plan', async () => {
      const result = await run({ plan: '   \n  ' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string plan', async () => {
      const result = await run({ plan: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ plan: SAMPLE_PLAN }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ plan: SAMPLE_PLAN }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when planMode controller missing', async () => {
      const ctx = makeCtx({ planMode: undefined });
      const result = await run({ plan: SAMPLE_PLAN }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });
  });
});
