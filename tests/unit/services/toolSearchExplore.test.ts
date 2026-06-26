import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

vi.mock('../../../src/host/services/infra/logger', () => ({
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

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    discoverLazyServersForSearch: vi.fn().mockResolvedValue([]),
  }),
}));

describe('ToolSearchService Explore metadata', () => {
  beforeEach(() => {
    resetProtocolRegistry();
  });

  it('loads Explore as a callable builtin protocol tool', () => {
    const service = new ToolSearchService();

    const result = service.selectTool('Explore');

    expect(result.loadedTools).toEqual(['Explore']);
    expect(result.tools[0]?.loadable).toBe(true);
    expect(result.tools[0]?.notCallableReason).toBeUndefined();
    expect(service.isToolLoaded('Explore')).toBe(true);
  });
});
