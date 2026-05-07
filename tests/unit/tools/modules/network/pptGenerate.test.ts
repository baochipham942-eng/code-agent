// ============================================================================
// ppt_generate (native ToolModule) Tests — P1 Wave 4 D2a
//
// 这里只验证 native 协议层（schema / 五链 / 错误码 / disabled gate / preview）。
// 实际 v7 工作流（pptxgenjs / VLM / research）走 ppt/__tests__/*.mjs 集成测试。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import { pptGenerateModule, executePptGenerate } from '../../../../../src/main/tools/modules/network/pptGenerate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await pptGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const ENV_FLAG = 'ENABLE_LEGACY_PPT_GENERATE';
const originalEnvFlag = process.env[ENV_FLAG];

beforeEach(() => {
  delete process.env[ENV_FLAG];
});

afterEach(() => {
  if (originalEnvFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = originalEnvFlag;
  }
});

describe('pptGenerateModule (native)', () => {
  describe('schema', () => {
    it('exposes correct metadata', () => {
      expect(pptGenerateModule.schema.name).toBe('ppt_generate');
      expect(pptGenerateModule.schema.category).toBe('network');
      expect(pptGenerateModule.schema.permissionLevel).toBe('network');
      expect(pptGenerateModule.schema.readOnly).toBe(false);
      expect(pptGenerateModule.schema.allowInPlanMode).toBe(false);
      expect(pptGenerateModule.schema.inputSchema.required).toEqual(['topic']);
    });

    it('declares all 9 themes (评测契约不能改)', () => {
      const props = pptGenerateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(props.theme?.enum).toEqual([
        'neon-green', 'neon-blue', 'neon-purple', 'neon-orange',
        'glass-light', 'glass-dark', 'minimal-mono', 'corporate', 'apple-dark',
      ]);
    });

    it('declares all 8 layouts in slides items.enum', () => {
      const props = pptGenerateModule.schema.inputSchema.properties as Record<
        string,
        { items?: { properties?: { layout?: { enum?: string[] } } } }
      >;
      expect(props.slides?.items?.properties?.layout?.enum).toEqual([
        'stats', 'cards-2', 'cards-3', 'list', 'timeline', 'comparison', 'quote', 'chart',
      ]);
    });

    it('declares 3 modes', () => {
      const props = pptGenerateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(props.mode?.enum).toEqual(['generate', 'template', 'design']);
    });
  });

  describe('五链 (canUseTool / abort / disabled)', () => {
    it('denies on canUseTool deny → PERMISSION_DENIED', async () => {
      const result = await run({ topic: 'test' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PERMISSION_DENIED');
        expect(result.error).toMatch(/blocked/);
      }
    });

    it('returns ABORTED when signal already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ topic: 'test' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns TOOL_DISABLED when env flag missing (default)', async () => {
      const result = await run({ topic: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('TOOL_DISABLED');
        expect(result.error).toMatch(/已临时禁用/);
        expect(result.error).toMatch(/frontend-slides/);
        expect(result.error).toContain('ENABLE_LEGACY_PPT_GENERATE');
      }
    });

    it('emits starting progress before disabled gate', async () => {
      const events: Array<{ stage: string }> = [];
      await run({ topic: 'test' }, makeCtx(), allowAll, (e) => events.push(e));
      expect(events[0]?.stage).toBe('starting');
    });
  });

  describe('preview mode (legacy parser path, no pptxgenjs)', () => {
    beforeEach(() => {
      process.env[ENV_FLAG] = '1';
    });

    it('returns preview text for legacy slides without writing file', async () => {
      const result = await run({
        topic: '单元测试主题',
        content: '# 章节一\n要点 1\n要点 2',
        preview: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output.length).toBeGreaterThan(0);
        expect(result.meta?.mode).toBe('preview');
        expect(typeof result.meta?.slidesCount).toBe('number');
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'ppt_generate',
          mimeType: 'text/markdown',
          metadata: {
            topic: '单元测试主题',
            mode: 'preview',
          },
        });
        expect(result.meta?.contentLength).toBe(result.output.length);
      }
    });

    it('returns structured preview when slides JSON provided', async () => {
      const result = await run({
        topic: '结构化预览',
        slides: [
          { layout: 'list', title: '第一页', points: ['a', 'b'], speakerNotes: '讲稿' },
          { layout: 'list', title: '第二页', points: ['x', 'y', 'z'] },
        ],
        preview: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('预览');
        expect(result.output).toContain('第一页');
        expect(result.output).toContain('第二页');
        expect(result.output).toContain('📝');
        expect(result.meta?.slidesCount).toBe(2);
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'ppt_generate',
          metadata: {
            topic: '结构化预览',
            slidesCount: 2,
            mode: 'preview',
          },
        });
      }
    });

    it('emits starting + completing progress in preview mode', async () => {
      const stages: string[] = [];
      const result = await run(
        { topic: '进度测试', preview: true },
        makeCtx(),
        allowAll,
        (e) => stages.push(e.stage),
      );
      expect(result.ok).toBe(true);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });

  describe('export shape', () => {
    it('exports pptGenerateModule with createHandler', async () => {
      expect(typeof pptGenerateModule.createHandler).toBe('function');
      const handler = await pptGenerateModule.createHandler();
      expect(handler.schema).toBe(pptGenerateModule.schema);
    });

    it('exports executePptGenerate as named function', () => {
      expect(typeof executePptGenerate).toBe('function');
    });
  });
});
