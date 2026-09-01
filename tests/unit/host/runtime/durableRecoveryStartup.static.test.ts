import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

describe('durable recovery production startup ordering', () => {
  it('webServer assembles before scheduling recovery behind remote MCP startup', () => {
    const source = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    const backgroundCapabilities = source.indexOf('startWebCapabilityBootstrap(configService)');
    const startup = source.indexOf('startDurableRunStartup({', backgroundCapabilities);
    const assembly = source.indexOf('assemble: () => assembleDurableRun({', startup);
    const recovery = source.indexOf('recover: (assembly) => assembly.recover({', assembly);
    expect(backgroundCapabilities).toBeGreaterThan(0);
    expect(startup).toBeGreaterThan(backgroundCapabilities);
    expect(assembly).toBeGreaterThan(startup);
    expect(recovery).toBeGreaterThan(assembly);
    expect(source).not.toContain('await startWebCapabilityBootstrap(configService)');
    expect(source).not.toContain('await initializeWebMcpServices(configService)');
    expect(source).toContain('durableRunRuntime?.shutdown()');
  });

  it('the shared initializer claims leases, dispatches recovery, and starts the lease sweeper', () => {
    const source = readFileSync(path.join(root, 'src/host/app/initializeDurableRun.ts'), 'utf8');
    const runtime = source.indexOf('createDurableRecoveryRuntime({');
    const recovery = source.indexOf('recoverAndDispatch(', runtime);
    const sweeper = source.indexOf('startSweeper(', recovery);
    expect(runtime).toBeGreaterThan(0);
    expect(recovery).toBeGreaterThan(runtime);
    expect(sweeper).toBeGreaterThan(recovery);
  });
});
