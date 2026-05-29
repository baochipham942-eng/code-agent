import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCoreToolDefinitions,
  getLoadedDeferredToolDefinitions,
} from '../../../src/main/tools/dispatch/toolDefinitions';
import {
  findToolSearchExecutionContractFailures,
  resolveToolSearchExecutionContract,
} from '../../../src/main/tools/dispatch/toolSearchExecutionContract';
import { getToolSearchService, resetToolSearchService } from '../../../src/main/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';
import type { ToolSearchItem } from '../../../src/shared/contract/toolSearch';

const mcpToolDefinition = {
  name: 'mcp__github__search_code',
  description: '[MCP:github] Search code',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  requiresPermission: true,
  permissionLevel: 'network' as const,
};

vi.mock('../../../src/main/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/main/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [mcpToolDefinition],
  }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('toolDefinitions deferred loading', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    resetToolSearchService();
  });

  it('includes loaded protocol tools and loaded MCP dynamic definitions', () => {
    const service = getToolSearchService();
    service.selectTool('Task');
    service.registerMCPTool({
      name: 'mcp__github__search_code',
      shortDescription: 'Search code on GitHub',
      tags: ['mcp', 'network'],
      aliases: ['search_code'],
      source: 'mcp',
      mcpServer: 'github',
    });
    service.selectTool('mcp__github__search_code');

    const definitions = getLoadedDeferredToolDefinitions();
    const names = definitions.map((definition) => definition.name);

    expect(names).toContain('Task');
    expect(names).toContain('mcp__github__search_code');
    expect(definitions.find((definition) => definition.name === 'mcp__github__search_code')).toEqual(mcpToolDefinition);
  });

  it('exposes Append as a core file tool', () => {
    const names = getCoreToolDefinitions().map((definition) => definition.name);
    expect(names).toContain('Write');
    expect(names).toContain('Append');
  });

  it('keeps core tools out of loaded deferred definitions after ToolSearch hits', async () => {
    const service = getToolSearchService();
    await service.searchTools('TaskManager', { maxResults: 3, includeMCP: false });

    const definitions = getLoadedDeferredToolDefinitions();

    expect(definitions.map((definition) => definition.name)).not.toContain('TaskManager');
  });

  it('includes canonical multiagent tools loaded through PascalCase aliases', () => {
    const service = getToolSearchService();
    service.selectTool('WaitAgent');
    service.selectTool('WorkflowOrchestrate');

    const names = getLoadedDeferredToolDefinitions().map((definition) => definition.name);

    expect(names).toContain('wait_agent');
    expect(names).toContain('workflow_orchestrate');
  });

  it('does not include selected searchable-only deferred metadata', () => {
    const service = getToolSearchService();
    service.selectTool('desktop_context_now');

    const definitions = getLoadedDeferredToolDefinitions();

    expect(definitions.map((definition) => definition.name)).not.toContain('desktop_context_now');
  });

  it('keeps ToolSearch loadable results aligned with executable definitions', () => {
    const service = getToolSearchService();
    const taskResult = service.selectTool('Task');
    service.registerMCPTool({
      name: 'mcp__github__search_code',
      shortDescription: 'Search code on GitHub',
      tags: ['mcp', 'network'],
      aliases: ['search_code'],
      source: 'mcp',
      mcpServer: 'github',
    });
    const mcpResult = service.selectTool('mcp__github__search_code');
    const desktopResult = service.selectTool('desktop_context_now');

    const items = [
      ...taskResult.tools,
      ...mcpResult.tools,
      ...desktopResult.tools,
    ];

    expect(findToolSearchExecutionContractFailures(items)).toEqual([]);
    expect(resolveToolSearchExecutionContract(taskResult.tools[0]!)).toMatchObject({
      executable: true,
      definitionName: 'Task',
      canonicalInvocation: 'Task',
    });
    expect(resolveToolSearchExecutionContract(mcpResult.tools[0]!)).toMatchObject({
      executable: true,
      definitionName: 'mcp__github__search_code',
      canonicalInvocation: 'mcp__github__search_code',
    });
    expect(resolveToolSearchExecutionContract(desktopResult.tools[0]!)).toMatchObject({
      executable: false,
      reason: expect.stringMatching(/Desktop workbench|no registered protocol tool/i),
    });
  });

  it('flags a loadable ToolSearch result when no executable definition can resolve', () => {
    const item: ToolSearchItem = {
      name: 'phantom_tool',
      description: 'Bad metadata',
      score: 1,
      source: 'builtin',
      loadable: true,
      canonicalInvocation: 'phantom_tool',
    };

    expect(findToolSearchExecutionContractFailures([item], {
      resolveDefinition: () => undefined,
    })).toEqual([
      {
        name: 'phantom_tool',
        issue: 'loadable search result has no executable ToolDefinition: phantom_tool',
        item,
      },
    ]);
  });
});
