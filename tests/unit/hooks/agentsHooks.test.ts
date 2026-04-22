import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionStartAgentsInjectHook } from '../../../src/main/hooks/builtins/agentsHooks';
import { discoverAgentFilesCached } from '../../../src/main/context/agentsDiscovery';

vi.mock('../../../src/main/context/agentsDiscovery', () => ({
  discoverAgentFilesCached: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('sessionStartAgentsInjectHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips injection when working directory resolves to filesystem root', async () => {
    const result = await sessionStartAgentsInjectHook({
      event: 'SessionStart',
      sessionId: 'session-root',
      workingDirectory: '/',
      timestamp: Date.now(),
    });

    expect(result.message).toBeUndefined();
    expect(discoverAgentFilesCached).not.toHaveBeenCalled();
  });

  it('discovers instructions from the session working directory', async () => {
    vi.mocked(discoverAgentFilesCached).mockResolvedValue({
      files: [
        {
          relativePath: 'AGENTS.md',
          absolutePath: '/tmp/comate-zulu-demo/AGENTS.md',
          directory: '.',
          content: '# Rules',
          modifiedAt: 0,
          sections: [],
        },
      ],
      combinedInstructions: '# Rules',
      totalFiles: 1,
      discoveryTimeMs: 1,
    });

    await sessionStartAgentsInjectHook({
      event: 'SessionStart',
      sessionId: 'session-project',
      workingDirectory: '/tmp/comate-zulu-demo',
      timestamp: Date.now(),
    });

    expect(discoverAgentFilesCached).toHaveBeenCalledWith('/tmp/comate-zulu-demo');
  });
});
