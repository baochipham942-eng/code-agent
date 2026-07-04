import { describe, expect, it, vi } from 'vitest';
import { handleDeclareDeliverablesGate } from '../../../../src/host/agent/runtime/declareDeliverablesGate';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { ToolCall } from '../../../../src/shared/contract';

function makeCtx(overrides: Partial<RuntimeContext> = {}) {
  const turnTrace = { record: vi.fn() };
  return {
    workingDirectory: '/tmp/workspace',
    sessionId: 's1',
    turnTrace,
    ...overrides,
  } as unknown as RuntimeContext;
}

function makeContextAssembly() {
  const injectSystemMessage = vi.fn();
  return {
    contextAssembly: { injectSystemMessage } as unknown as ContextAssembly,
    injectSystemMessage,
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `tc-${name}`, name, arguments: args };
}

describe('handleDeclareDeliverablesGate', () => {
  it('returns null and leaves ctx unchanged when no declare_deliverables call exists', () => {
    const ctx = makeCtx();
    const { contextAssembly, injectSystemMessage } = makeContextAssembly();

    const result = handleDeclareDeliverablesGate(ctx, contextAssembly, [
      toolCall('Read', { file_path: 'README.md' }),
    ]);

    expect(result).toBeNull();
    expect(ctx.declaredDeliverables).toBeUndefined();
    expect(injectSystemMessage).not.toHaveBeenCalled();
  });

  it('valid call records declared deliverables and injects confirmation', () => {
    const ctx = makeCtx();
    const { contextAssembly, injectSystemMessage } = makeContextAssembly();
    const before = Date.now();

    const result = handleDeclareDeliverablesGate(ctx, contextAssembly, [
      toolCall('declare_deliverables', {
        final_artifacts: ['dist/index.html', '/tmp/workspace/report.md'],
        scratch_dir: 'draft',
      }),
    ]);
    const after = Date.now();

    expect(result).toBe('continue');
    expect(ctx.declaredDeliverables?.finalArtifacts).toEqual(['dist/index.html', '/tmp/workspace/report.md']);
    expect(ctx.declaredDeliverables?.scratchDir).toBe('draft');
    expect(ctx.declaredDeliverables?.declaredAtMs).toBeGreaterThanOrEqual(before);
    expect(ctx.declaredDeliverables?.declaredAtMs).toBeLessThanOrEqual(after);
    expect(injectSystemMessage).toHaveBeenCalledTimes(1);
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('<deliverables-declared>'));
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('dist/index.html'));
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('draft'));
  });

  it('second valid call overrides the previous declaration and says so', () => {
    const ctx = makeCtx({
      declaredDeliverables: {
        finalArtifacts: ['old/game.html'],
        scratchDir: 'old-draft',
        declaredAtMs: 1,
      },
    });
    const { contextAssembly, injectSystemMessage } = makeContextAssembly();

    const result = handleDeclareDeliverablesGate(ctx, contextAssembly, [
      toolCall('declare_deliverables', {
        final_artifacts: ['new/index.html'],
        scratch_dir: 'new-draft',
      }),
    ]);

    expect(result).toBe('continue');
    expect(ctx.declaredDeliverables?.finalArtifacts).toEqual(['new/index.html']);
    expect(ctx.declaredDeliverables?.scratchDir).toBe('new-draft');
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('已覆盖之前的声明'));
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('old/game.html'));
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('new/index.html'));
  });

  it.each([
    ['missing final_artifacts', {}],
    ['empty final_artifacts', { final_artifacts: [] }],
  ])('invalid call (%s) does not mutate ctx and injects rejection', (_label, args) => {
    const previous = {
      finalArtifacts: ['existing/final.html'],
      scratchDir: 'scratch',
      declaredAtMs: 123,
    };
    const ctx = makeCtx({ declaredDeliverables: previous });
    const { contextAssembly, injectSystemMessage } = makeContextAssembly();

    const result = handleDeclareDeliverablesGate(ctx, contextAssembly, [
      toolCall('declare_deliverables', args),
    ]);

    expect(result).toBe('continue');
    expect(ctx.declaredDeliverables).toBe(previous);
    expect(injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<deliverables-declaration-rejected>'),
    );
    expect(injectSystemMessage).toHaveBeenCalledWith(expect.stringContaining('final_artifacts'));
  });
});
