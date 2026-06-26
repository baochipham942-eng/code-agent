// ============================================================================
// FindingsWrite (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

import { findingsWriteModule } from '../../../../../src/host/tools/modules/planning/findingsWrite';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

interface MockService {
  initialize: ReturnType<typeof vi.fn>;
  findings: {
    add: ReturnType<typeof vi.fn>;
    getCount: ReturnType<typeof vi.fn>;
  };
}

function makeMockService(addResult = { id: 'f-1' }, count = 5): MockService {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    findings: {
      add: vi.fn().mockResolvedValue(addResult),
      getCount: vi.fn().mockResolvedValue(count),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findings_write schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(findingsWriteModule.schema.name).toBe('findings_write');
    expect(findingsWriteModule.schema.category).toBe('planning');
    expect(findingsWriteModule.schema.permissionLevel).toBe('write');
    expect(findingsWriteModule.schema.allowInPlanMode).toBe(true);
    expect(findingsWriteModule.schema.inputSchema.required).toEqual(['category', 'title', 'content']);
    const props = findingsWriteModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.category.enum).toEqual(['code', 'architecture', 'dependency', 'issue', 'insight']);
  });
});

describe('findings_write behavior', () => {
  it('Invalid category → INVALID_ARGS', async () => {
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'foo', title: 't', content: 'c' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('缺 title → INVALID_ARGS', async () => {
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'code', content: 'c' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('title');
    }
  });

  it('缺 content → INVALID_ARGS', async () => {
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'code', title: 't' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('content');
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'code', title: 't', content: 'c' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'code', title: 't', content: 'c' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('缺 planningService → NOT_INITIALIZED', async () => {
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'code', title: 't', content: 'c' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('Planning service not available');
    }
  });

  it('happy path → 输出 1:1 复刻 + 调用 add/getCount', async () => {
    const service = makeMockService({ id: 'f-42' }, 7);
    const handler = await findingsWriteModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { category: 'insight', title: 'My Title', content: 'My content', source: 'foo.ts' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Finding saved to findings.md:');
      expect(result.output).toContain('**Category:** insight');
      expect(result.output).toContain('**Title:** My Title');
      expect(result.output).toContain('**ID:** f-42');
      expect(result.output).toContain('Total findings: 7');
    }
    expect(service.initialize).toHaveBeenCalled();
    expect(service.findings.add).toHaveBeenCalledWith({
      category: 'insight',
      title: 'My Title',
      content: 'My content',
      source: 'foo.ts',
    });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'findings_write' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('add throws → DOMAIN_ERROR', async () => {
    const service = makeMockService();
    service.findings.add.mockRejectedValueOnce(new Error('disk full'));
    const handler = await findingsWriteModule.createHandler();
    const result = await handler.execute(
      { category: 'code', title: 't', content: 'c' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('disk full');
    }
  });
});
