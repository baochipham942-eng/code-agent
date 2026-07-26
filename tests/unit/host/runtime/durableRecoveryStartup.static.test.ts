import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

describe('durable recovery production startup ordering', () => {
  it('webServer initializes durable recovery without waiting for remote MCP startup', () => {
    const source = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    const backgroundCapabilities = source.indexOf('startWebCapabilityBootstrap(configService)');
    const runtime = source.indexOf('await initializeDurableRun({', backgroundCapabilities);
    expect(backgroundCapabilities).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(backgroundCapabilities);
    expect(source).not.toContain('await startWebCapabilityBootstrap(configService)');
    expect(source).not.toContain('await initializeWebMcpServices(configService)');
    expect(source).toContain('durableRunRuntime?.shutdown()');
  });

  it('dead Host bootstrap no longer depends on the removed background-service entry', () => {
    const source = readFileSync(path.join(root, 'src/host/app/bootstrap.ts'), 'utf8');
    expect(source).not.toContain('initBackgroundServices');
    expect(source).not.toContain('initializeBackgroundInfra');
    expect(source).toContain('await initializeDurableRun({');
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
