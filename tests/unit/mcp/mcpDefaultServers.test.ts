import { describe, expect, it } from 'vitest';
import type { MCPServerCloudConfig } from '../../../src/main/services/cloud/cloudConfigService';
import { convertCloudConfigToInternal } from '../../../src/main/mcp/mcpDefaultServers';

describe('mcpDefaultServers', () => {
  it('rewrites deprecated DeepWiki SSE cloud config to streamable HTTP', () => {
    const result = convertCloudConfigToInternal({
      id: 'deepwiki',
      name: 'DeepWiki',
      type: 'sse',
      enabled: true,
      config: {
        url: 'https://mcp.deepwiki.com/sse',
      },
    } satisfies MCPServerCloudConfig);

    expect(result).toMatchObject({
      name: 'deepwiki',
      type: 'http-streamable',
      serverUrl: 'https://mcp.deepwiki.com/mcp',
      enabled: true,
    });
  });
});
