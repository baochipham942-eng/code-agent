import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

describe('durable recovery production startup ordering', () => {
  it('webServer initializes MCP and handlers before recovery and reuses the runtime for delayed scan', () => {
    const source = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    const mcp = source.indexOf('await initializeWebMcpServices(configService)');
    const runtime = source.indexOf('await initializeDurableRun({', mcp);
    expect(mcp).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(mcp);
    expect(source).toContain('durableRunRuntime?.shutdown()');
  });

  it('Host bootstrap initializes background MCP dependencies before registering and dispatching recovery', () => {
    const source = readFileSync(path.join(root, 'src/host/app/bootstrap.ts'), 'utf8');
    const background = source.indexOf('await initializeBackgroundInfra(configService)');
    const runtime = source.indexOf('await initializeDurableRun({', background);
    expect(background).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(background);
    expect(source).toContain('shutdownDurableRecovery');
  });

  it('the shared initializer claims leases, dispatches recovery, and schedules the delayed scan', () => {
    const source = readFileSync(path.join(root, 'src/host/app/initializeDurableRun.ts'), 'utf8');
    const runtime = source.indexOf('createDurableRecoveryRuntime({');
    const recovery = source.indexOf('recoverAndDispatch(', runtime);
    const delayed = source.indexOf('scheduleDelayedScan(', recovery);
    expect(runtime).toBeGreaterThan(0);
    expect(recovery).toBeGreaterThan(runtime);
    expect(delayed).toBeGreaterThan(recovery);
  });
});
