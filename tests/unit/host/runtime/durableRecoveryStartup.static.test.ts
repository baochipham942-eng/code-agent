import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

describe('durable recovery production startup ordering', () => {
  it('webServer initializes MCP and handlers before recovery and reuses the runtime for delayed scan', () => {
    const source = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    const mcp = source.indexOf('await initializeWebMcpServices(configService)');
    const runtime = source.indexOf('createDurableRecoveryRuntime({', mcp);
    const recovery = source.indexOf('recoverAndDispatch(Date.now())', runtime);
    const delayed = source.indexOf('scheduleDelayedScan(', recovery);
    expect(mcp).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(mcp);
    expect(recovery).toBeGreaterThan(runtime);
    expect(delayed).toBeGreaterThan(recovery);
    expect(source).toContain('durableRecoveryRuntime?.shutdown()');
  });

  it('Host bootstrap initializes background MCP dependencies before registering and dispatching recovery', () => {
    const source = readFileSync(path.join(root, 'src/host/app/bootstrap.ts'), 'utf8');
    const background = source.indexOf('await initializeBackgroundInfra(configService)');
    const runtime = source.indexOf('createDurableRecoveryRuntime({', background);
    const recovery = source.indexOf('recoverAndDispatch(Date.now())', runtime);
    const delayed = source.indexOf('scheduleDelayedScan(', recovery);
    expect(background).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(background);
    expect(recovery).toBeGreaterThan(runtime);
    expect(delayed).toBeGreaterThan(recovery);
    expect(source).toContain('shutdownDurableRecovery');
  });
});
