// ============================================================================
// EnterPlanMode (native ToolModule) Tests — P0-6.3 Batch B1
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
  enterPlanModeModule,
  DEFAULT_ENTER_REASON,
} from '../../../../../src/main/tools/migrated/planning/enterPlanMode';

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
    _active: false,
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
  const handler = await enterPlanModeModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('enterPlanModeModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(enterPlanModeModule.schema.name).toBe('enter_plan_mode');
      expect(enterPlanModeModule.schema.category).toBe('planning');
      expect(enterPlanModeModule.schema.permissionLevel).toBe('write');
      expect(enterPlanModeModule.schema.allowInPlanMode).toBe(true);
      expect(enterPlanModeModule.schema.inputSchema.properties).toHaveProperty('reason');
    });
  });

  describe('execution', () => {
    it('activates plan mode via ctx.planMode.enter()', async () => {
      const planMode = makeFakePlanMode();
      const ctx = makeCtx({ planMode });
      const result = await run({}, ctx);
      expect(result.ok).toBe(true);
      expect(planMode._active).toBe(true);
      expect(planMode.enterCalls).toEqual([DEFAULT_ENTER_REASON]);
    });

    it('uses provided reason', async () => {
      const planMode = makeFakePlanMode();
      const ctx = makeCtx({ planMode });
      const result = await run({ reason: '实现新功能' }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('实现新功能');
        expect(result.meta?.reason).toBe('实现新功能');
      }
      expect(planMode.enterCalls).toEqual(['实现新功能']);
    });

    it('falls back to default reason when absent', async () => {
      const result = await run({});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain(DEFAULT_ENTER_REASON);
    });

    it('includes planning guidance in output', async () => {
      const result = await run({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已进入规划模式');
        expect(result.output).toContain('探索与设计');
        expect(result.output).toContain('exit_plan_mode');
      }
    });

    it('emits plan_mode_entered AgentEvent', async () => {
      const emit = vi.fn<[AgentEvent], void>();
      const ctx = makeCtx({ emit });
      await run({ reason: 'abc' }, ctx);
      expect(emit).toHaveBeenCalledTimes(1);
      const ev = emit.mock.calls[0][0];
      expect(ev.type).toBe('plan_mode_entered');
      expect((ev as { data: { reason: string } }).data.reason).toBe('abc');
    });

    it('emits onProgress starting + completing', async () => {
      const onProgress = vi.fn();
      await run({}, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });

  describe('validation & errors', () => {
    it('rejects non-string reason', async () => {
      const result = await run({ reason: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({}, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({}, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when planMode controller missing', async () => {
      const ctx = makeCtx({ planMode: undefined });
      const result = await run({}, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });
  });
});
