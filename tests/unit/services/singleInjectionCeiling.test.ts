import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFERRED_TOOL_LOADING } from '../../../src/shared/constants/tools';
import { estimateTokens } from '../../../src/host/context/tokenEstimator';
import {
  boundSingleInjection,
  type InjectedToolSchema,
} from '../../../src/host/services/toolSearch/singleInjectionCeiling';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch';
import { DEFERRED_TOOLS_META } from '../../../src/host/services/toolSearch/deferredTools';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  getLoadedDeferredToolDefinitions,
  getToolDefinitionWithCloudMeta,
  readDeferredToolInjectionSchemas,
} from '../../../src/host/tools/dispatch/toolDefinitions';
import { executeToolSearch } from '../../../src/host/tools/modules/search/toolSearch';
import type { ToolContext } from '../../../src/host/protocol/tools';
import { getCloudConfigService } from '../../../src/host/services/cloud';
import '../../../src/host/agent/agentRegistry';

interface McpDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const mcpState = vi.hoisted(() => ({
  definitions: [] as McpDefinition[],
  discover: async (): Promise<unknown[]> => [],
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    discoverLazyServersForSearch: () => mcpState.discover(),
    getToolDefinitions: () => mcpState.definitions,
  }),
}));

const CEILING = DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING;
const EXPLICIT_CEILING = DEFERRED_TOOL_LOADING.EXPLICIT_SELECT_INJECTION_TOKEN_CEILING;

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

  it('refuses a schema that exceeds the ceiling instead of trimming its description', () => {
    const loaded = schema({
      name: 'HugeDesc',
      description: 'verbose parameter essay '.repeat(400),
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'semantic parameter text' } },
        required: ['url'],
      },
    });
    expect(estimateTokens(claudeToolInjectionText(loaded))).toBeGreaterThan(CEILING);
    const bounded = boundSingleInjection({
      text: `已加载 HugeDesc。${'detail '.repeat(200)}`,
      namesText: '• **HugeDesc**',
      schemas: [loaded],
    });

    expect(bounded.fitsSchemas).toBe(false);
    expect(bounded.schemas).toEqual([]);
    expect(bounded.measured).toBeGreaterThan(CEILING);
    expect(estimateTokens(bounded.text)).toBeLessThanOrEqual(CEILING);
    expect(bounded.text).toContain('HugeDesc');
  });

  it('keeps a full schema and bounds only the result text', () => {
    const loaded = schema({
      name: 'Medium',
      description: 'd'.repeat(80),
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'semantic parameter text' } },
        required: ['url'],
      },
    });
    const bounded = boundSingleInjection({
      text: `detail ${'word '.repeat(400)}`,
      namesText: '• **Medium**',
      schemas: [loaded],
    });

    expect(bounded.fitsSchemas).toBe(true);
    expect(bounded.schemas[0]?.description).toBe(loaded.description);
    expect(JSON.stringify(bounded.schemas[0]?.input_schema)).toContain('semantic parameter text');
    expect(singleInjectionTokens(bounded.text, bounded.schemas)).toBeLessThanOrEqual(CEILING);
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

function searchContext(sessionId = 'session-ceiling'): ToolContext {
  return {
    sessionId,
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: () => undefined,
  } as unknown as ToolContext;
}

function allow(): Promise<{ allow: true }> {
  return Promise.resolve({ allow: true });
}

function ceilingFailure(result: {
  error: string;
  code?: string;
  meta?: Record<string, unknown>;
}): { measured: number; allowed: number } {
  expect(result.code).toBe('INJECTION_CEILING');
  expect(result.error.startsWith('INJECTION_CEILING')).toBe(true);
  expect(result.error).not.toMatch(/[\u3400-\u9fff]/);
  const match = /measured=(\d+) allowed=(\d+)/.exec(result.error);
  if (!match) throw new Error(`missing measured/allowed in: ${result.error}`);
  const measured = Number(match[1]);
  const allowed = Number(match[2]);
  expect(result.meta).toMatchObject({ measured, allowed });
  return { measured, allowed };
}

describe('ToolSearch output plus newly loaded schema', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    resetToolSearchService();
    mcpState.definitions = [];
    mcpState.discover = async () => [];
  });

  it('fits screenshot_page so the sent schema and the ToolSearch text share one ceiling', async () => {
    getProtocolRegistry();
    const raw = readDeferredToolInjectionSchemas(['screenshot_page'])[0];
    expect(raw).toBeDefined();
    expect(raw!.sentTokens!).toBeGreaterThan(CEILING);

    const result = await executeToolSearch(
      { query: 'select:screenshot_page' },
      searchContext(),
      allow,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('screenshot_page');
    const sent = getLoadedDeferredToolDefinitions().find((tool) => tool.name === 'screenshot_page');
    expect(sent).toBeDefined();
    expect(sent!.description).toBe(raw!.description);
    expect(JSON.stringify(sent!.inputSchema)).toBe(JSON.stringify(raw!.input_schema));
    expect(estimateTokens(result.output) + raw!.sentTokens!).toBeLessThanOrEqual(EXPLICIT_CEILING);
  });

  it('fails a user MCP schema that exceeds the explicit total and does not trim it', async () => {
    const name = 'HugeMcpSchema';
    let width = 400;
    const build = (count: number): McpDefinition => ({
      name,
      description: 'huge user schema',
      inputSchema: {
        type: 'object',
        properties: {
          blob: {
            type: 'string',
            description: 'semantic parameter text that must stay intact',
            enum: Array.from({ length: count }, (_, index) => `choice_${index}_${'x'.repeat(64)}`),
          },
        },
        required: ['blob'],
      },
    });
    mcpState.definitions = [build(width)];
    let measured = readDeferredToolInjectionSchemas([name])[0];
    while ((measured?.sentTokens ?? 0) <= EXPLICIT_CEILING && width < 20000) {
      width *= 2;
      mcpState.definitions = [build(width)];
      measured = readDeferredToolInjectionSchemas([name])[0];
    }
    expect(measured?.sentTokens).toBeGreaterThan(EXPLICIT_CEILING);

    const service = getToolSearchService();
    expect(service.selectTool('MemoryWrite', 'session-ceiling').loadedTools).toEqual(['MemoryWrite']);
    service.registerMCPTool({
      name,
      shortDescription: 'huge schema fixture',
      tags: ['network'],
      aliases: [],
      source: 'mcp',
      mcpServer: 'fixture',
    });

    const result = await executeToolSearch({ query: `select:${name}` }, searchContext(), allow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const counts = ceilingFailure(result);
    expect(counts.allowed).toBe(EXPLICIT_CEILING);
    expect(counts.measured).toBeGreaterThan(EXPLICIT_CEILING);
    expect(counts.measured).toBeGreaterThanOrEqual(measured!.sentTokens!);
    expect(service.isToolLoaded(name)).toBe(false);
    expect(service.isToolLoaded('MemoryWrite')).toBe(true);
    expect(getLoadedDeferredToolDefinitions().some((tool) => tool.name === name)).toBe(false);
    const kept = getLoadedDeferredToolDefinitions().find((tool) => tool.name === 'MemoryWrite');
    expect(kept?.description.length).toBeGreaterThan(0);

    resetToolSearchService();
    const keywordService = getToolSearchService();
    keywordService.registerMCPTool({
      name,
      shortDescription: 'huge schema fixture',
      tags: ['network'],
      aliases: [],
      source: 'mcp',
      mcpServer: 'fixture',
    });
    const keyword = await executeToolSearch({ query: name }, searchContext(), allow);
    expect(keyword.ok).toBe(true);
    if (!keyword.ok) return;
    expect(keywordService.isToolLoaded(name)).toBe(false);
    expect(keyword.output).toContain('超过单次注入上限');
    expect(keyword.output).toContain(`select:${name}`);
    expect(estimateTokens(keyword.output)).toBeLessThanOrEqual(CEILING);
  });

  it.each(['TaskManager', 'ppt_generate', 'MemoryWrite', 'AgentSpawn'])(
    'select:%s keeps the original schema inside the explicit total',
    async (name) => {
      getProtocolRegistry();
      const raw = readDeferredToolInjectionSchemas([name])[0];
      expect(raw).toBeDefined();
      const result = await executeToolSearch({ query: `select:${name}` }, searchContext(), allow);

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
      expect(sentSchema.description).toBe(raw!.description);
      expect(JSON.stringify(sentSchema.input_schema)).toBe(JSON.stringify(raw!.input_schema));
      if (name === 'TaskManager') {
        expect(sentSchema.input_schema).toHaveProperty(['properties', 'description']);
        const parameter = (sentSchema.input_schema.properties as { description?: { description?: string } }).description;
        expect(parameter?.description?.length).toBeGreaterThan(0);
      }
      expect(estimateTokens(result.output) + raw!.sentTokens!).toBeLessThanOrEqual(EXPLICIT_CEILING);
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
    if (result.ok) {
      const raw = readDeferredToolInjectionSchemas(['TaskManager'])[0];
      expect(estimateTokens(result.output) + (raw?.sentTokens ?? 0)).toBeLessThanOrEqual(EXPLICIT_CEILING);
    }
  });

  it('selects every loadable builtin inside the explicit total with its schema intact', async () => {
    getProtocolRegistry();
    const checked: string[] = [];
    for (const meta of DEFERRED_TOOLS_META) {
      if (meta.source !== 'builtin') continue;
      resetToolSearchService();
      const result = await executeToolSearch(
        { query: `select:${meta.name}` },
        searchContext(),
        allow,
      );
      const loaded = getToolSearchService().getLoadedDeferredTools();
      if (!loaded.includes(meta.name)) {
        expect(result.ok).toBe(true);
        continue;
      }
      expect(result.ok, `${meta.name} rejected`).toBe(true);
      if (!result.ok) return;
      const raw = readDeferredToolInjectionSchemas([meta.name])[0];
      const sent = getLoadedDeferredToolDefinitions().find((tool) => tool.name === meta.name);
      expect(sent?.description, meta.name).toBe(raw?.description);
      expect(JSON.stringify(sent?.inputSchema), meta.name).toBe(JSON.stringify(raw?.input_schema));
      expect(estimateTokens(result.output) + (raw?.sentTokens ?? 0), meta.name).toBeLessThanOrEqual(EXPLICIT_CEILING);
      checked.push(meta.name);
    }
    expect(checked.length).toBeGreaterThan(50);
    expect(checked).toContain('Task');
    expect(checked).toContain('TaskManager');
  });

  it('still selects AgentSpawn when the real catalog grows by 30 agents', async () => {
    getProtocolRegistry();
    const holder = globalThis as typeof globalThis & {
      codeAgentAgentRegistry?: { listAllAgents?: () => readonly { id: string; description?: string }[] };
    };
    const previous = holder.codeAgentAgentRegistry;
    const real = previous?.listAllAgents?.() ?? [];
    holder.codeAgentAgentRegistry = {
      listAllAgents: () => [
        ...real,
        ...Array.from({ length: 30 }, (_, index) => ({
          id: `extra-agent-${index}`,
          description: `catalog fixture ${'x'.repeat(80)}`,
        })),
      ],
    };
    try {
      const measured = readDeferredToolInjectionSchemas(['AgentSpawn'])[0];
      expect(measured?.description).toContain('extra-agent-29');
      expect(measured?.sentTokens).toBeGreaterThan(2500);
      expect(measured?.sentTokens).toBeLessThanOrEqual(EXPLICIT_CEILING);
      const result = await executeToolSearch({ query: 'select:AgentSpawn' }, searchContext(), allow);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sent = getLoadedDeferredToolDefinitions().find((tool) => tool.name === 'AgentSpawn');
      expect(sent?.description).toContain('extra-agent-29');
      expect(estimateTokens(result.output) + (measured?.sentTokens ?? 0)).toBeLessThanOrEqual(EXPLICIT_CEILING);
    } finally {
      holder.codeAgentAgentRegistry = previous;
    }
  });

  it('measures the dynamic agent catalog and rejects a catalog that exceeds the explicit total', async () => {
    getProtocolRegistry();
    const holder = globalThis as typeof globalThis & {
      codeAgentAgentRegistry?: { listAllAgents?: () => readonly { id: string; description?: string }[] };
    };
    const previous = holder.codeAgentAgentRegistry;
    const staticTask = getToolDefinitionWithCloudMeta('Task');
    expect(staticTask?.description).toContain('\n- coder:');
    try {
      const service = getToolSearchService();
      expect(service.selectTool('MemoryWrite', 'session-ceiling').loadedTools).toEqual(['MemoryWrite']);
      let count = 40;
      const install = (size: number) => {
        holder.codeAgentAgentRegistry = {
          listAllAgents: () => Array.from({ length: size }, (_, index) => ({
            id: `fixture-agent-${index}`,
            description: `catalog fixture ${'x'.repeat(80)}`,
          })),
        };
      };
      install(count);
      let measured = readDeferredToolInjectionSchemas(['Task'])[0];
      while ((measured?.sentTokens ?? 0) <= EXPLICIT_CEILING && count < 8000) {
        count *= 2;
        install(count);
        measured = readDeferredToolInjectionSchemas(['Task'])[0];
      }
      expect(measured?.description).toContain('fixture-agent-0');
      expect(measured?.description).not.toContain('\n- coder:');
      expect(measured?.sentTokens).toBeGreaterThan(EXPLICIT_CEILING);

      const result = await executeToolSearch({ query: 'select:Task' }, searchContext(), allow);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const counts = ceilingFailure(result);
      expect(counts.allowed).toBe(EXPLICIT_CEILING);
      expect(counts.measured).toBeGreaterThanOrEqual(measured!.sentTokens!);
      expect(service.isToolLoaded('Task')).toBe(false);
      expect(service.isToolLoaded('MemoryWrite')).toBe(true);
    } finally {
      holder.codeAgentAgentRegistry = previous;
    }
  });

  it('uses one description resolution for measurement and rendering, including an empty cloud override', () => {
    getProtocolRegistry();
    const baseline = readDeferredToolInjectionSchemas(['Task'])[0];
    expect(baseline?.description).toContain('\n- coder:');
    const spy = vi.spyOn(getCloudConfigService(), 'getAllToolMeta').mockReturnValue({
      Task: { name: 'Task', description: '' },
      MemoryWrite: { name: 'MemoryWrite', description: 'REMOTE COPY' },
    });
    try {
      const emptyCloud = readDeferredToolInjectionSchemas(['Task'])[0];
      expect(emptyCloud?.description).toBe(baseline?.description);
      expect(getToolDefinitionWithCloudMeta('Task')?.description).toBe(baseline?.description);
      const remote = readDeferredToolInjectionSchemas(['MemoryWrite'])[0];
      expect(remote?.description).toBe('REMOTE COPY');
      expect(getToolDefinitionWithCloudMeta('MemoryWrite')?.description).toBe('REMOTE COPY');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not unload a tool another session loaded during discovery await', async () => {
    getProtocolRegistry();
    const name = 'CeilingRaceTool';
    mcpState.definitions = [{
      name,
      description: `${'race schema '.repeat(400)}`,
      inputSchema: {
        type: 'object',
        properties: { note: { type: 'string', description: 'kept parameter description' } },
      },
    }];
    const measured = readDeferredToolInjectionSchemas([name])[0];
    expect(measured?.sentTokens).toBeGreaterThan(CEILING);
    expect(measured?.sentTokens).toBeLessThanOrEqual(EXPLICIT_CEILING);

    mcpState.discover = async () => {
      getToolSearchService().registerMCPTool({
        name,
        shortDescription: 'race fixture',
        tags: ['network'],
        aliases: [],
        source: 'mcp',
        mcpServer: 'fixture',
      });
      getToolSearchService().selectTool(name, 'session-b');
      return [];
    };

    const result = await executeToolSearch({ query: name }, searchContext('session-a'), allow);
    expect(result.ok).toBe(true);
    expect(getToolSearchService().isToolLoaded(name)).toBe(true);
    const sent = getLoadedDeferredToolDefinitions().find((tool) => tool.name === name);
    expect(JSON.stringify(sent?.inputSchema)).toContain('kept parameter description');
  });
});
