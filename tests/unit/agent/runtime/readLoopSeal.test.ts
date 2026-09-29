import { describe, expect, it, vi } from 'vitest';
import { AntiPatternDetector } from '../../../../src/host/agent/antiPattern/detector';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import {
  applyReadLoopHardLimit,
  isReadLikeToolCall,
  releaseReadLoopSealAfterSuccessfulWrite,
} from '../../../../src/host/agent/runtime/readLoopSeal';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    antiPatternDetector: new AntiPatternDetector(),
    control: ControlState.forTest(),
    ...overrides,
  } as RuntimeContext;
}

describe('isReadLikeToolCall', () => {
  const ctx = makeCtx();

  it('treats READ_ONLY_TOOLS as read-like', () => {
    expect(isReadLikeToolCall(ctx, { name: 'Read', arguments: { file_path: '/tmp/a.ts' } })).toBe(true);
    expect(isReadLikeToolCall(ctx, { name: 'Glob', arguments: { pattern: '**/*.md' } })).toBe(true);
    expect(isReadLikeToolCall(ctx, { name: 'Grep', arguments: { pattern: 'foo' } })).toBe(true);
    expect(isReadLikeToolCall(ctx, { name: 'WebSearch', arguments: { query: 'x' } })).toBe(true);
    expect(isReadLikeToolCall(ctx, { name: 'WebFetch', arguments: { url: 'https://example.test' } })).toBe(true);
  });

  it('treats write tools and artifact generators as not read-like', () => {
    expect(isReadLikeToolCall(ctx, { name: 'Write', arguments: { file_path: '/tmp/out.docx', content: 'x' } })).toBe(false);
    expect(isReadLikeToolCall(ctx, { name: 'Edit', arguments: { file_path: '/tmp/a.ts' } })).toBe(false);
    expect(isReadLikeToolCall(ctx, { name: 'ppt_generate', arguments: { file_path: '/tmp/out.pptx' } })).toBe(false);
    expect(isReadLikeToolCall(ctx, { name: 'docx_generate', arguments: { file_path: '/tmp/out.docx' } })).toBe(false);
  });

  it('classifies Bash by inverting isReadOnlyShellCommand', () => {
    expect(isReadLikeToolCall(ctx, { name: 'Bash', arguments: { command: 'cat evidence.txt' } })).toBe(true);
    expect(isReadLikeToolCall(ctx, { name: 'bash', arguments: { command: 'rg "foo" src' } })).toBe(true);
    expect(isReadLikeToolCall(ctx, { name: 'Bash', arguments: { command: 'python3 -c "Path(\'out.docx\').write_text(\'x\')"' } })).toBe(false);
    expect(isReadLikeToolCall(ctx, { name: 'Bash', arguments: { command: 'touch /tmp/out.docx' } })).toBe(false);
  });
});

describe('read-loop seal prompt and error', () => {
  it('tells the model to stop researching and deliver, and still allows write tools', () => {
    const ctx = makeCtx();
    const injectPrompt = vi.fn();
    const result = applyReadLoopHardLimit(ctx, { id: 'read-15', name: 'Read' }, Date.now(), injectPrompt);
    expect(injectPrompt.mock.calls[0]?.[0]).toContain('Stop researching');
    expect(injectPrompt.mock.calls[0]?.[0]).toContain('Deliver immediately');
    expect(String(injectPrompt.mock.calls[0]?.[0])).not.toContain('Do not call any tool');
    expect(result.error).toContain('立刻交付');
    expect(result.error).toContain('基于已经获取到的文件或搜索证据');
  });
});

describe('applyReadLoopHardLimit', () => {
  it('activates the read seal without forceFinal on the triggering call', () => {
    const ctx = makeCtx();
    const injectPrompt = vi.fn();

    const result = applyReadLoopHardLimit(ctx, { id: 'read-15', name: 'Read' }, Date.now() - 1, injectPrompt);

    expect(ctx.control.readLoopSealActive).toBe(true);
    expect(ctx.control.readLoopSealBlockedReads).toBe(0);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(injectPrompt.mock.calls[0]?.[0]).toContain('Stop researching');
    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({ readLoopSeal: true, hardLimitPreflight: true });
  });

  it('escalates to full forceFinal after 3 extra blocked reads', () => {
    const ctx = makeCtx();
    const injectPrompt = vi.fn();
    applyReadLoopHardLimit(ctx, { id: 'read-15', name: 'Read' }, Date.now(), injectPrompt);

    for (let index = 0; index < 2; index += 1) {
      applyReadLoopHardLimit(ctx, { id: `read-extra-${index}`, name: 'Read' }, Date.now(), injectPrompt);
      expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    }

    const escalated = applyReadLoopHardLimit(
      ctx,
      { id: 'read-escalate', name: 'Read' },
      Date.now(),
      injectPrompt,
    );

    expect(ctx.control.readLoopSealBlockedReads).toBe(3);
    expect(ctx.control.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');
    expect(ctx.control.forceFinalResponsePrompt).toContain('Do not call any tool');
    expect(escalated.metadata?.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');
    expect(injectPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('releaseReadLoopSealAfterSuccessfulWrite', () => {
  it('clears the seal after a successful write-class tool', () => {
    const ctx = makeCtx();
    ctx.control.activateReadLoopSeal();
    ctx.control.recordBlockedReadDuringReadLoopSeal();

    releaseReadLoopSealAfterSuccessfulWrite(
      ctx,
      { name: 'Write', arguments: { file_path: '/tmp/out.docx', content: 'x' } },
      true,
    );

    expect(ctx.control.readLoopSealActive).toBe(false);
    expect(ctx.control.readLoopSealBlockedReads).toBe(0);
  });

  it('keeps the seal on failed writes and on successful reads', () => {
    const ctx = makeCtx();
    ctx.control.activateReadLoopSeal();
    releaseReadLoopSealAfterSuccessfulWrite(
      ctx,
      { name: 'Write', arguments: { file_path: '/tmp/out.docx', content: 'x' } },
      false,
    );
    expect(ctx.control.readLoopSealActive).toBe(true);

    releaseReadLoopSealAfterSuccessfulWrite(
      ctx,
      { name: 'Read', arguments: { file_path: '/tmp/out.docx' } },
      true,
    );
    expect(ctx.control.readLoopSealActive).toBe(true);
  });
});

describe('ControlState read-loop seal', () => {
  it('records blocked reads and can be seeded for tests', () => {
    const state = new ControlState();
    expect(state.readLoopSealActive).toBe(false);
    state.activateReadLoopSeal();
    expect(state.readLoopSealActive).toBe(true);
    expect(state.recordBlockedReadDuringReadLoopSeal()).toBe(1);
    expect(state.recordBlockedReadDuringReadLoopSeal()).toBe(2);
    state.clearReadLoopSeal();
    expect(state.readLoopSealActive).toBe(false);
    expect(state.readLoopSealBlockedReads).toBe(0);

    const seeded = ControlState.forTest({ readLoopSealActive: true, readLoopSealBlockedReads: 2 });
    expect(seeded.readLoopSealActive).toBe(true);
    expect(seeded.readLoopSealBlockedReads).toBe(2);
  });
});
