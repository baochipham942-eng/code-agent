import { describe, expect, it, vi } from 'vitest';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/host/protocol/tools';
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { registerMigratedTools } from '../../../../../src/host/tools/modules';
import { declareDeliverablesModule } from '../../../../../src/host/tools/modules/planning/declareDeliverables';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('declareDeliverablesModule', () => {
  it('has the expected planning schema metadata', () => {
    expect(declareDeliverablesModule.schema.name).toBe('declare_deliverables');
    expect(declareDeliverablesModule.schema.category).toBe('planning');
    expect(declareDeliverablesModule.schema.permissionLevel).toBe('read');
    expect(declareDeliverablesModule.schema.readOnly).toBe(true);
    expect(declareDeliverablesModule.schema.allowInPlanMode).toBe(false);
    expect(declareDeliverablesModule.schema.inputSchema.required).toContain('final_artifacts');
  });

  it('is visible through migrated tool registration', async () => {
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'win32');

    expect(registry.has('declare_deliverables')).toBe(true);
    const handler = await registry.resolve('declare_deliverables');
    expect(handler.schema.name).toBe('declare_deliverables');
    expect(handler.schema.category).toBe('planning');
  });

  it('fallback executor returns an ok no-op result', async () => {
    const handler = await declareDeliverablesModule.createHandler();
    const result = await handler.execute(
      { final_artifacts: ['dist/index.html'], scratch_dir: 'draft' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('declare_deliverables');
      expect(result.output).toContain('无副作用');
    }
  });
});
