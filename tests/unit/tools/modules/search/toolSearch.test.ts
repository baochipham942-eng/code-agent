// ============================================================================
// ToolSearch (native ToolModule) Tests — P1 Wave 1
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock service singletons
// -----------------------------------------------------------------------------

const searchToolsMock = vi.fn();
const discoverLazyServersForSearchMock = vi.fn();

vi.mock('../../../../../src/main/services/toolSearch/toolSearchService', () => ({
  getToolSearchService: () => ({
    searchTools: searchToolsMock,
  }),
}));

vi.mock('../../../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    discoverLazyServersForSearch: discoverLazyServersForSearchMock,
  }),
}));

import { toolSearchModule } from '../../../../../src/main/tools/modules/search/toolSearch';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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
  const handler = await toolSearchModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  searchToolsMock.mockReset();
  discoverLazyServersForSearchMock.mockReset();
  discoverLazyServersForSearchMock.mockResolvedValue([]);
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('toolSearchModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata aligned with legacy contract', () => {
      expect(toolSearchModule.schema.name).toBe('ToolSearch');
      expect(toolSearchModule.schema.category).toBe('fs');
      expect(toolSearchModule.schema.permissionLevel).toBe('read');
      expect(toolSearchModule.schema.readOnly).toBe(true);
      expect(toolSearchModule.schema.allowInPlanMode).toBe(true);
      expect(toolSearchModule.schema.inputSchema.required).toEqual(['query']);
      // 字段对齐：query/max_results 字段名不能改
      const props = (toolSearchModule.schema.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('query');
      expect(props).toHaveProperty('max_results');
    });
  });

  describe('validation & errors', () => {
    it('rejects missing query', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty query string', async () => {
      const result = await run({ query: '   ' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string query', async () => {
      const result = await run({ query: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ query: 'pdf' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ query: 'pdf' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('wraps service errors as SEARCH_ERROR', async () => {
      searchToolsMock.mockRejectedValue(new Error('boom'));
      const result = await run({ query: 'pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('SEARCH_ERROR');
        expect(result.error).toContain('工具搜索失败');
        expect(result.error).toContain('boom');
      }
    });

    it('survives downstream MCP discovery failure (warn but proceed)', async () => {
      discoverLazyServersForSearchMock.mockRejectedValue(new Error('mcp down'));
      searchToolsMock.mockResolvedValue({
        tools: [],
        loadedTools: [],
        totalCount: 0,
        hasMore: false,
      });
      const ctx = makeCtx();
      const result = await run({ query: 'pdf' }, ctx);
      expect(result.ok).toBe(true);
      // logger.warn 被调到
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
  });

  describe('result formatting', () => {
    it('formats no-hit response with hint and discovery failures', async () => {
      discoverLazyServersForSearchMock.mockResolvedValue([
        { serverName: 'sequential-thinking', connected: false, toolCount: 0, error: 'spawn failed' },
      ]);
      searchToolsMock.mockResolvedValue({
        tools: [],
        loadedTools: [],
        totalCount: 0,
        hasMore: false,
      });
      const result = await run({ query: 'sequential-nohit', max_results: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('未找到匹配 "sequential-nohit"');
        expect(result.output).toContain('MCP 懒加载发现失败');
        expect(result.output).toContain('sequential-thinking: spawn failed');
        expect(result.output).toContain('提示：');
        expect(result.meta?.mcpDiscovery).toEqual([
          { serverName: 'sequential-thinking', connected: false, toolCount: 0, error: 'spawn failed' },
        ]);
      }
    });

    it('formats not-callable hits without claiming they are loaded', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          {
            name: 'desktop_context_now',
            description: 'Desktop context',
            tags: ['desktop'],
            source: 'builtin',
            loadable: false,
            notCallableReason: 'no registered protocol tool',
          },
        ],
        loadedTools: [],
        totalCount: 1,
        hasMore: false,
      });
      const result = await run({ query: 'desktop', max_results: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('找到 1 个匹配工具，已加载 0 个');
        expect(result.output).toContain('• **desktop_context_now**');
        expect(result.output).toContain('不可直接调用');
        expect(result.output).toContain('没有新工具被加载');
        expect(result.output).not.toContain('已加载的工具现在可以直接使用');
      }
    });

    it('formats loadable hits and includes canonicalInvocation', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          {
            name: 'mcp__github__search_code',
            description: 'Search code on GitHub',
            tags: ['mcp'],
            source: 'mcp',
            mcpServer: 'github',
            loadable: true,
            canonicalInvocation: 'mcp__github__search_code',
          },
        ],
        loadedTools: ['mcp__github__search_code'],
        totalCount: 1,
        hasMore: false,
      });
      const result = await run({ query: 'search_code', max_results: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('• **mcp__github__search_code** [MCP: github]');
        expect(result.output).toContain('已加载，可直接调用');
        expect(result.output).toContain('调用入口：mcp__github__search_code');
        expect(result.output).toContain('已加载的工具现在可以直接使用');
        expect(result.meta?.loadedTools).toEqual(['mcp__github__search_code']);
      }
    });

    it('formats skill hits with not-callable reason and invocation', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          {
            name: 'skill:commit',
            description: 'Prepare a git commit',
            tags: ['skill'],
            source: 'builtin',
            loadable: false,
            notCallableReason: 'use Skill tool',
            canonicalInvocation: 'Skill({"command":"commit"})',
          },
        ],
        loadedTools: [],
        totalCount: 1,
        hasMore: false,
      });
      const result = await run({ query: 'commit', max_results: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('• **skill:commit**');
        expect(result.output).toContain('不可直接调用');
        expect(result.output).toContain('调用入口：Skill({"command":"commit"})');
      }
    });

    it('appends hasMore notice when total exceeds tools length', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          { name: 'a', description: 'a', tags: [], source: 'builtin', loadable: true, canonicalInvocation: 'a' },
        ],
        loadedTools: ['a'],
        totalCount: 7,
        hasMore: true,
      });
      const result = await run({ query: 'foo', max_results: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('还有 6 个匹配结果');
      }
    });
  });

  describe('max_results', () => {
    it('defaults to 5 and caps at 10', async () => {
      searchToolsMock.mockResolvedValue({ tools: [], loadedTools: [], totalCount: 0, hasMore: false });

      await run({ query: 'foo' });
      expect(searchToolsMock).toHaveBeenLastCalledWith('foo', { maxResults: 5, includeMCP: true });

      await run({ query: 'foo', max_results: 100 });
      expect(searchToolsMock).toHaveBeenLastCalledWith('foo', { maxResults: 10, includeMCP: true });

      await run({ query: 'foo', max_results: 3 });
      expect(searchToolsMock).toHaveBeenLastCalledWith('foo', { maxResults: 3, includeMCP: true });
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      searchToolsMock.mockResolvedValue({ tools: [], loadedTools: [], totalCount: 0, hasMore: false });
      const onProgress = vi.fn();
      await run({ query: 'foo' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
