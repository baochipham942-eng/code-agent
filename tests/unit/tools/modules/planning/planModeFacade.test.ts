// ============================================================================
// PlanMode facade (native ToolModule) Tests — P0-6.3 Batch B1
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
  planModeFacadeModule,
  PLAN_MODE_ACTIONS,
} from '../../../../../src/main/tools/modules/planning/planModeFacade';

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

function makeFakePlanMode(initialActive = false): FakePlanMode {
  const state: FakePlanMode = {
    _active: initialActive,
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

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await planModeFacadeModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('planModeFacadeModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(planModeFacadeModule.schema.name).toBe('PlanMode');
      expect(planModeFacadeModule.schema.category).toBe('planning');
      expect(planModeFacadeModule.schema.permissionLevel).toBe('write');
      expect(planModeFacadeModule.schema.allowInPlanMode).toBe(true);
      expect(planModeFacadeModule.schema.inputSchema.required).toContain('action');
    });

    it('declares action enum', () => {
      const props = planModeFacadeModule.schema.inputSchema.properties as Record<
        string,
        { enum?: readonly string[] }
      >;
      expect(props.action?.enum).toEqual([...PLAN_MODE_ACTIONS]);
    });
  });

  describe('dispatch', () => {
    it('action=enter delegates to enter_plan_mode handler', async () => {
      const planMode = makeFakePlanMode();
      const emit = vi.fn<[AgentEvent], void>();
      const ctx = makeCtx({ planMode, emit });
      const result = await run({ action: 'enter', reason: 'facade-test' }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('facade-test');
      expect(planMode.enterCalls).toEqual(['facade-test']);
      expect(planMode._active).toBe(true);
      // emitted via inner handler
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].type).toBe('plan_mode_entered');
    });

    it('action=exit delegates to exit_plan_mode handler', async () => {
      const planMode = makeFakePlanMode(true);
      const emit = vi.fn<[AgentEvent], void>();
      const ctx = makeCtx({ planMode, emit });
      const plan = '## Plan\n- A\n- B';
      const result = await run({ action: 'exit', plan }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain(plan);
        expect(result.meta?.requiresUserConfirmation).toBe(true);
      }
      expect(planMode._active).toBe(false);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].type).toBe('plan_mode_exited');
    });

    it('rejects unknown action', async () => {
      const result = await run({ action: 'status' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Unknown action');
      }
    });

    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('propagates exit validation errors (missing plan)', async () => {
      const result = await run({ action: 'exit' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('propagates NOT_INITIALIZED when planMode missing', async () => {
      const ctx = makeCtx({ planMode: undefined });
      const result = await run({ action: 'enter' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('emits onProgress events', async () => {
      const onProgress = vi.fn();
      await run({ action: 'enter' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
