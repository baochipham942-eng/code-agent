// ============================================================================
// ToolSearch (native ToolModule) Tests — P1 Wave 1
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { estimateTokens } from '../../../../../src/host/context/tokenEstimator';
import { DEFERRED_TOOL_LOADING } from '../../../../../src/shared/constants/tools';

// -----------------------------------------------------------------------------
// Mock service singletons
// -----------------------------------------------------------------------------

const searchToolsMock = vi.fn();
const discoverLazyServersForSearchMock = vi.fn();

vi.mock('../../../../../src/host/services/toolSearch/toolSearchService', () => ({
  getToolSearchService: () => ({
    searchTools: searchToolsMock,
    rollbackInserted: vi.fn(),
    getLoadedDeferredTools: () => [],
  }),
  setProtocolToolNameChecker: vi.fn(),
}));

vi.mock('../../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    discoverLazyServersForSearch: discoverLazyServersForSearchMock,
    getToolDefinitions: () => [],
  }),
}));

const markDistilledSkillTurnSignalMock = vi.fn((_input: unknown) => true);
vi.mock('../../../../../src/host/services/skills/distillSignalStore', () => ({
  markDistilledSkillTurnSignal: (input: unknown) =>
    markDistilledSkillTurnSignalMock(input),
}));

import { toolSearchModule } from '../../../../../src/host/tools/modules/search/toolSearch';
import { validateToolInputSchema } from '../../../../../src/host/tools/toolSchemaValidator';

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
  markDistilledSkillTurnSignalMock.mockReset();
  markDistilledSkillTurnSignalMock.mockReturnValue(true);
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
    // P1 §1.3 #7：query 的必填/非空白/类型校验已从 handler 删除，
    // 改由 executor/resolver 的 schema 门统一拦截。
    it('missing query is rejected by the schema layer', () => {
      const issues = validateToolInputSchema(toolSearchModule.schema.inputSchema, {});
      expect(issues.some((i) => i.field_path === 'query' && i.category === 'missing_required')).toBe(true);
    });

    it('whitespace-only query is rejected by the schema layer', () => {
      const issues = validateToolInputSchema(toolSearchModule.schema.inputSchema, { query: '   ' });
      expect(issues.some((i) => i.field_path === 'query' && i.category === 'constraint_violation')).toBe(true);
    });

    it('non-string query is rejected by the schema layer', () => {
      const issues = validateToolInputSchema(toolSearchModule.schema.inputSchema, { query: 123 });
      expect(issues.some((i) => i.field_path === 'query' && i.category === 'type_mismatch')).toBe(true);
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

    // N-MCP-LAZYCONNECT-SIGNAL ③：ctx.abortSignal 端到端传进懒发现——
    // 等待被 abort 打断时 search 立即往下走，不阻塞到连接超时
    it('passes ctx.abortSignal into lazy discovery so the wait is abortable', async () => {
      const ctrl = new AbortController();
      discoverLazyServersForSearchMock.mockImplementation(
        (_query: string, _allowlist: string[] | undefined, signal?: AbortSignal) =>
          new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve([]), { once: true });
          }),
      );
      searchToolsMock.mockResolvedValue({
        tools: [],
        loadedTools: [],
        totalCount: 0,
        hasMore: false,
      });

      const pending = run({ query: 'pdf' }, makeCtx({ abortSignal: ctrl.signal }));
      setTimeout(() => ctrl.abort(), 20);

      const startedAt = Date.now();
      const result = await pending;
      expect(Date.now() - startedAt).toBeLessThan(200); // 发现等待被打断，立即继续
      expect(result.ok).toBe(true);
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
        expect(result.meta?.query).toBe('sequential-nohit');
        expect(result.meta?.results).toEqual([]);
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('search');
        expect(artifact.metadata?.resultCount).toBe(0);
      }
    });

    it('caps no-hit discovery failures at the single-injection token ceiling', async () => {
      discoverLazyServersForSearchMock.mockResolvedValue(
        Array.from({ length: 200 }, (_, index) => ({
          serverName: `server-${index}`,
          connected: false,
          toolCount: 0,
          error: 'discovery failed with a verbose diagnostic payload',
        })),
      );
      searchToolsMock.mockResolvedValue({
        tools: [],
        loadedTools: [],
        totalCount: 0,
        hasMore: false,
      });

      const result = await run({ query: 'no-hit' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(estimateTokens(result.output)).toBeLessThanOrEqual(DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING);
        expect(result.output).toContain('未找到匹配 "no-hit"');
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

    it('tells the model to select loadable hits that were not auto-unlocked', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          {
            name: 'pdf_generate',
            description: 'Generate a PDF',
            tags: ['document'],
            source: 'builtin',
            loadable: true,
          },
          {
            name: 'PdfAutomate',
            description: 'Automate an existing PDF',
            tags: ['document'],
            source: 'builtin',
            loadable: true,
          },
        ],
        loadedTools: [],
        totalCount: 2,
        hasMore: false,
      });

      const result = await run({ query: 'pdf', max_results: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('• **pdf_generate**');
        expect(result.output).toContain('Generate a PDF');
        expect(result.output).toContain('使用 select:pdf_generate 加载');
        expect(result.output).toContain('使用 select:PdfAutomate 加载');
        expect(result.output).toContain('未注入完整 schema');
        expect(result.output).not.toContain('已加载，可直接调用');
        expect(estimateTokens(result.output)).toBeLessThanOrEqual(DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING);
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
        expect(result.meta?.query).toBe('search_code');
        expect(Array.isArray(result.meta?.results)).toBe(true);
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('search');
        expect(artifact.metadata?.resultCount).toBe(1);
        expect(artifact.metadata?.loadedCount).toBe(1);
      }
    });

    // 与 mcpUnified 同一份口径：收窄生效时不把范围外 server 的工具搜出来——
    // 搜出来模型照单点名、调用在 dispatch 门挨挡，「看见却调不动」比看不见更误导
    it('turn scope 收窄时不搜出范围外 server 的工具', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          { name: 'mcp__github__search_code', description: 'Search code', tags: ['mcp'], source: 'mcp', mcpServer: 'github', loadable: true },
          { name: 'mcp__lark__doc_read', description: 'Read doc', tags: ['mcp'], source: 'mcp', mcpServer: 'lark', loadable: true },
        ],
        loadedTools: ['mcp__github__search_code', 'mcp__lark__doc_read'],
        totalCount: 2,
        hasMore: false,
      });
      const scopedCtx = makeCtx({ toolScope: { allowedMcpServerIds: ['lark'] } } as Partial<ToolContext>);
      const result = await run({ query: 'read', max_results: 5 }, scopedCtx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('mcp__lark__doc_read');
        expect(result.output).not.toContain('mcp__github__search_code');
        // 计数与列出的条目对齐——不出现「找到 2 个」却只列 1 条、再补「还有 1 个」
        expect(result.output).toContain('找到 1 个匹配工具');
        expect(result.output).not.toContain('还有');
      }
    });

    // hasMore 保留服务真值：范围内匹配超过 maxResults 时，模型该知道还能缩关键词
    it('turn scope 过滤后 hasMore 为真时给不带假计数的提示', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          { name: 'mcp__lark__doc_read', description: 'Read doc', tags: ['mcp'], source: 'mcp', mcpServer: 'lark', loadable: true },
          { name: 'mcp__github__search_code', description: 'Search code', tags: ['mcp'], source: 'mcp', mcpServer: 'github', loadable: true },
        ],
        loadedTools: ['mcp__lark__doc_read', 'mcp__github__search_code'],
        totalCount: 5,
        hasMore: true,
      });
      const scopedCtx = makeCtx({ toolScope: { allowedMcpServerIds: ['lark'] } } as Partial<ToolContext>);
      const result = await run({ query: 'read', max_results: 5 }, scopedCtx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('范围内可能还有更多匹配结果');
        expect(result.output).not.toContain('还有 0 个');
      }
    });

    // discovery 会真的把 lazy stdio server 拉起子进程——范围外的拉起来结果也会被丢掉，
    // scope 判据必须前置到 discovery 调用上（ai-review 第十四轮 Nit）
    it('turn scope 收窄时 lazy discovery 只拉起范围内的 server', async () => {
      searchToolsMock.mockResolvedValue({ tools: [], loadedTools: [], totalCount: 0, hasMore: false });
      const scopedCtx = makeCtx({ toolScope: { allowedMcpServerIds: ['lark'] } } as Partial<ToolContext>);
      await run({ query: 'feishu' }, scopedCtx);
      expect(discoverLazyServersForSearchMock).toHaveBeenCalledWith('feishu', ['lark'], expect.any(AbortSignal));

      discoverLazyServersForSearchMock.mockClear();
      await run({ query: 'feishu' });
      expect(discoverLazyServersForSearchMock).toHaveBeenCalledWith('feishu', undefined, expect.any(AbortSignal));
    });

    // 与 loadedTools 同一份完整 scope 门：连接器侧被收窄的工具也不能只滤一半（ai-review 第十五轮 Nit）
    it('turn scope 收窄到连接器时，范围外的连接器工具也不搜出', async () => {
      searchToolsMock.mockResolvedValue({
        tools: [
          { name: 'mail', description: 'Read mail', tags: ['connector'], source: 'connector', loadable: true },
          { name: 'calendar_create_event', description: 'Create event', tags: ['connector'], source: 'connector', loadable: true },
        ],
        loadedTools: ['mail', 'calendar_create_event'],
        totalCount: 2,
        hasMore: false,
      });
      const scopedCtx = makeCtx({ toolScope: { allowedConnectorIds: ['mail'] } } as Partial<ToolContext>);
      const result = await run({ query: 'event' }, scopedCtx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('• **mail**');
        expect(result.output).not.toContain('calendar_create_event');
        expect(result.output).toContain('找到 1 个匹配工具');
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
      const result = await run(
        { query: 'commit', max_results: 1 },
        makeCtx({ turnId: 'turn-search-1' } as Partial<ToolContext>),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('• **skill:commit**');
        expect(result.output).toContain('不可直接调用');
        expect(result.output).toContain('调用入口：Skill({"command":"commit"})');
      }
      expect(markDistilledSkillTurnSignalMock).toHaveBeenCalledWith({
        turnId: 'turn-search-1',
        skillName: 'commit',
        sessionId: 'test-session',
        kind: 'selected',
      });
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

    it('enforces the single-injection token ceiling while keeping result names searchable', async () => {
      searchToolsMock.mockResolvedValue({
        tools: Array.from({ length: 5 }, (_, index) => ({
          name: `mcp__mock__tool_${String(index).padStart(3, '0')}`,
          description: 'A deliberately verbose description '.repeat(30),
          tags: ['mcp'],
          source: 'mcp',
          loadable: true,
        })),
        loadedTools: ['mcp__mock__tool_000'],
        totalCount: 500,
        hasMore: true,
      });

      const result = await run({ query: 'mock', max_results: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(estimateTokens(result.output)).toBeLessThanOrEqual(DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING);
        expect(result.output).toContain('mcp__mock__tool_000');
        expect(result.output).toContain('mcp__mock__tool_004');
      }
    });
  });

  describe('max_results', () => {
    it('defaults to 3 and caps at 5', async () => {
      searchToolsMock.mockResolvedValue({ tools: [], loadedTools: [], totalCount: 0, hasMore: false });

      await run({ query: 'foo' });
      expect(searchToolsMock).toHaveBeenLastCalledWith('foo', { maxResults: 3, includeMCP: true, sessionId: 'test-session' });

      await run({ query: 'foo', max_results: 100 });
      expect(searchToolsMock).toHaveBeenLastCalledWith('foo', { maxResults: 5, includeMCP: true, sessionId: 'test-session' });

      await run({ query: 'foo', max_results: 3 });
      expect(searchToolsMock).toHaveBeenLastCalledWith('foo', { maxResults: 3, includeMCP: true, sessionId: 'test-session' });
    });
  });

  it('passes the run denylist into deferred tool discovery', async () => {
    searchToolsMock.mockResolvedValue({ tools: [], loadedTools: [], totalCount: 0, hasMore: false });

    await run({ query: 'select:AgentSpawn' }, makeCtx({ deniedToolNames: ['AgentSpawn'] }));

    expect(searchToolsMock).toHaveBeenCalledWith('select:AgentSpawn', {
      maxResults: 3,
      includeMCP: true,
      sessionId: 'test-session',
      deniedToolNames: ['AgentSpawn'],
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
