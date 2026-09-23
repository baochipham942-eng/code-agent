import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFERRED_TOOL_LOADING } from '../../../src/shared/constants/tools';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import {
  boundSingleInjection,
  type InjectedToolSchema,
} from '../../../src/host/services/toolSearch/singleInjectionCeiling';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getLoadedDeferredToolDefinitions } from '../../../src/host/tools/dispatch/toolDefinitions';
import { executeToolSearch } from '../../../src/host/tools/modules/search/toolSearch';
import type { ToolContext, ToolModule, ToolSchema } from '../../../src/host/protocol/tools';
import { readDeferredToolInjectionSchemas } from '../../../src/host/tools/dispatch/toolDefinitions';

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    discoverLazyServersForSearch: async () => [],
    getToolDefinitions: () => [],
  }),
}));

const CEILING = DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING;

function claudeToolInjectionText(schema: InjectedToolSchema): string {
  return JSON.stringify({
    name: schema.name,
    description: schema.description,
    input_schema: schema.input_schema,
  });
}

function singleInjectionTokens(text: string, schemas: readonly InjectedToolSchema[]): number {
  return estimateTokens(text) + schemas.reduce(
    (sum, schema) => sum + estimateTokens(claudeToolInjectionText(schema)),
    0,
  );
}

function schema(partial: Partial<InjectedToolSchema> & Pick<InjectedToolSchema, 'name'>): InjectedToolSchema {
  return {
    name: partial.name,
    description: partial.description ?? '',
    input_schema: partial.input_schema ?? { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  };
}

describe('single injection ceiling', () => {
  it('keeps a small schema and the search text inside the ceiling', () => {
    const loaded = schema({ name: 'Task', description: 'short' });
    const text = '找到 1 个匹配工具，已加载 1 个：\n\n• **Task**\n';
    const bounded = boundSingleInjection({ text, namesText: '• **Task**', schemas: [loaded] });

    expect(singleInjectionTokens(bounded.text, bounded.schemas)).toBeLessThanOrEqual(CEILING);
    expect(bounded.schemas[0]?.description).toBe('short');
    expect(bounded.text).toContain('Task');
  });

  it('shrinks a large description but keeps the parameter schema callable', () => {
    const loaded = schema({
      name: 'HugeDesc',
      description: 'verbose parameter essay '.repeat(400),
    });
    expect(estimateTokens(claudeToolInjectionText(loaded))).toBeGreaterThan(CEILING);
    const bounded = boundSingleInjection({
      text: `已加载 HugeDesc。${'detail '.repeat(200)}`,
      namesText: '• **HugeDesc**',
      schemas: [loaded],
    });

    expect(singleInjectionTokens(bounded.text, bounded.schemas)).toBeLessThanOrEqual(CEILING);
    expect(bounded.schemas).toHaveLength(1);
    expect(JSON.stringify(bounded.schemas[0]?.input_schema)).toContain('url');
    expect(bounded.text).toContain('HugeDesc');
    expect(bounded.schemas[0]?.description.length).toBeLessThan(loaded.description.length);
  });

  it('drops a schema whose skeleton alone exceeds the ceiling and still names the tool', () => {
    const loaded = schema({
      name: 'HugeSchema',
      description: 'x',
      input_schema: {
        type: 'object',
        properties: {
          blob: {
            type: 'string',
            enum: Array.from({ length: 400 }, (_, index) => `choice_${index}_${'x'.repeat(24)}`),
          },
        },
        required: ['blob'],
      },
    });
    expect(estimateTokens(claudeToolInjectionText({ ...loaded, description: '' }))).toBeGreaterThan(CEILING);
    const bounded = boundSingleInjection({
      text: '找到 HugeSchema',
      namesText: '• **HugeSchema**',
      schemas: [loaded],
    });

    expect(bounded.schemas).toEqual([]);
    expect(estimateTokens(bounded.text)).toBeLessThanOrEqual(CEILING);
    expect(bounded.text).toContain('HugeSchema');
  });
});

describe('ToolSearch output plus newly loaded schema', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    resetToolSearchService();
  });

  it('fits screenshot_page so the sent schema and the ToolSearch text share one ceiling', async () => {
    getProtocolRegistry();
    const raw = readDeferredToolInjectionSchemas(['screenshot_page'])[0];
    expect(raw).toBeDefined();
    expect(estimateTokens(claudeToolInjectionText(raw!))).toBeGreaterThan(CEILING);

    const ctx = {
      sessionId: 'session-ceiling',
      workingDir: process.cwd(),
      abortSignal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: () => undefined,
      turnId: 'turn-ceiling',
    } as unknown as ToolContext;

    const result = await executeToolSearch(
      { query: 'select:screenshot_page' },
      ctx,
      async () => ({ allow: true }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('screenshot_page');
    const sent = getLoadedDeferredToolDefinitions().find((tool) => tool.name === 'screenshot_page');
    expect(sent).toBeDefined();
    const sentSchema: InjectedToolSchema = {
      name: sent!.name,
      description: sent!.description,
      input_schema: sent!.inputSchema as unknown as Record<string, unknown>,
    };
    expect(JSON.stringify(sentSchema.input_schema)).toContain('url');
    expect(singleInjectionTokens(result.output, [sentSchema])).toBeLessThanOrEqual(CEILING);
    expect(estimateTokens(claudeToolInjectionText(sentSchema))).toBeLessThanOrEqual(CEILING);
  });

  it('does not inject a registered schema that cannot fit even with an empty description', async () => {
    const name = 'HugeSchema';
    const toolSchema: ToolSchema = {
      name,
      description: 'huge',
      outputSchema: { type: 'string' },
      inputSchema: {
        type: 'object',
        properties: {
          blob: {
            type: 'string',
            enum: Array.from({ length: 400 }, (_, index) => `choice_${index}_${'x'.repeat(24)}`),
          },
        },
        required: ['blob'],
      },
      category: 'network',
      permissionLevel: 'network',
      readOnly: false,
    };
    const module: ToolModule = {
      schema: toolSchema,
      createHandler: () => ({ schema: toolSchema, async execute() { return { ok: true, output: null }; } }),
    };
    getProtocolRegistry().register(toolSchema, async () => module);
    const service = getToolSearchService();
    service.registerMCPTool({
      name,
      shortDescription: 'huge schema fixture',
      tags: ['network'],
      aliases: [],
      source: 'mcp',
      mcpServer: 'fixture',
    });

    const ctx = {
      sessionId: 'session-ceiling',
      workingDir: process.cwd(),
      abortSignal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: () => undefined,
    } as unknown as ToolContext;
    const result = await executeToolSearch(
      { query: `select:${name}` },
      ctx,
      async () => ({ allow: true }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(service.isToolLoaded(name)).toBe(false);
    expect(getLoadedDeferredToolDefinitions().some((tool) => tool.name === name)).toBe(false);
    expect(result.output).toContain(name);
    expect(result.output).toContain('超过单次注入上限');
    expect(estimateTokens(result.output)).toBeLessThanOrEqual(CEILING);
    const loadedSchemaTokens = getLoadedDeferredToolDefinitions().reduce((sum, tool) => sum + estimateTokens(JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })), 0);
    expect(estimateTokens(result.output) + loadedSchemaTokens).toBeLessThanOrEqual(CEILING);
  });

  it.each(['TaskManager', 'ppt_generate', 'MemoryWrite', 'AgentSpawn'])(
    'select:%s stays loaded and the sent schema shares the ceiling with the result text',
    async (name) => {
      getProtocolRegistry();
      const ctx = {
        sessionId: 'session-ceiling',
        workingDir: process.cwd(),
        abortSignal: new AbortController().signal,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        emit: () => undefined,
      } as unknown as ToolContext;
      const result = await executeToolSearch(
        { query: `select:${name}` },
        ctx,
        async () => ({ allow: true }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(getToolSearchService().isToolLoaded(name)).toBe(true);
      const sent = getLoadedDeferredToolDefinitions().find((tool) => tool.name === name);
      expect(sent).toBeDefined();
      const sentSchema: InjectedToolSchema = {
        name: sent!.name,
        description: sent!.description,
        input_schema: sent!.inputSchema as unknown as Record<string, unknown>,
      };
      expect(sentSchema.input_schema).toHaveProperty('properties');
      expect(singleInjectionTokens(result.output, [sentSchema])).toBeLessThanOrEqual(CEILING);
    },
  );

  it('does not unload a tool that was already loaded before this select', async () => {
    getProtocolRegistry();
    const service = getToolSearchService();
    expect(service.selectTool('TaskManager', 'session-ceiling').loadedTools).toEqual(['TaskManager']);
    const before = getLoadedDeferredToolDefinitions().find((tool) => tool.name === 'TaskManager');
    expect(before).toBeDefined();

    const ctx = {
      sessionId: 'session-ceiling',
      workingDir: process.cwd(),
      abortSignal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: () => undefined,
    } as unknown as ToolContext;
    const result = await executeToolSearch(
      { query: 'select:TaskManager' },
      ctx,
      async () => ({ allow: true }),
    );

    expect(result.ok).toBe(true);
    expect(service.isToolLoaded('TaskManager')).toBe(true);
    const after = getLoadedDeferredToolDefinitions().find((tool) => tool.name === 'TaskManager');
    expect(after?.description).toBe(before?.description);
    expect(JSON.stringify(after?.inputSchema)).toBe(JSON.stringify(before?.inputSchema));
  });
});
