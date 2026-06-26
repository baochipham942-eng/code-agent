import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CODE_AGENT_CLI_MODE = 'true';
});

vi.mock('../../../src/host/platform', () => ({
  app: {
    getPath: () => '/tmp/code-agent-log-collector-test',
  },
}));

import { createLogCollector } from '../../../src/host/mcp/logCollector';

describe('LogCollector secret redaction', () => {
  it('redacts secrets in messages and metadata before storing logs', () => {
    const collector = createLogCollector({ enablePersistence: false });
    const rawKey = `sk-${'e'.repeat(24)}`;

    collector.agent('ERROR', `provider failed for ${rawKey}`, {
      apiKey: rawKey,
      nested: {
        message: `masked key sk-2769d*****7e68`,
      },
      keys: [rawKey],
    });

    const [entry] = collector.getLogs('agent');
    const serialized = JSON.stringify(entry);

    expect(entry?.message).toContain('sk-***REDACTED***');
    expect(serialized).not.toContain(rawKey);
    expect(serialized).not.toContain('sk-2769d*****7e68');
    expect(entry?.metadata?.apiKey).toBe('***REDACTED***');
  });
});
