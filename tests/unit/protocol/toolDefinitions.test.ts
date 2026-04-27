import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoadedDeferredToolDefinitions } from '../../../src/main/tools/dispatch/toolDefinitions';
import { getToolSearchService, resetToolSearchService } from '../../../src/main/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';

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

  it('does not include selected searchable-only deferred metadata', () => {
    const service = getToolSearchService();
    service.selectTool('desktop_context_now');

    const definitions = getLoadedDeferredToolDefinitions();

    expect(definitions.map((definition) => definition.name)).not.toContain('desktop_context_now');
  });
});
