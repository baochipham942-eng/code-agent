import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const modules = [
  'src/host/agent/agentTeamDurableLaunch.ts',
  'src/host/agent/agentTeamGraphCompatibility.ts',
  'src/host/agent/parallelAgentDurableRecovery.ts',
  'src/host/agent/runtime/contextAssembly/inferenceTelemetry.ts',
  'src/host/agent/runtime/contextAssembly/nativeModelCheckpoint.ts',
  'src/host/agent/subagentExecutionTracing.ts',
  'src/host/agent/subagentLifecycleHooks.ts',
  'src/host/agent/subagentProtocolContext.ts',
  'src/host/agent/subagentToolRuntime.ts',
  'src/host/services/core/database/durableRunDatabaseSupport.ts',
  'src/host/tools/cachedToolReplay.ts',
  'src/host/tools/nativeToolCheckpoint.ts',
  'src/host/tools/toolExecutionLedger.ts',
  'src/host/tools/toolExecutionTelemetry.ts',
  'src/web/routes/agentDurableRouteLifecycle.ts',
  'src/web/routes/registerAgentCancelRoute.ts',
] as const;

function effectiveLines(source: string): number {
  return source.split(/\r?\n/).filter((line) => {
    const value = line.trim();
    return value
      && !value.startsWith('//')
      && !value.startsWith('/*')
      && !value.startsWith('*')
      && !value.startsWith('*/');
  }).length;
}

describe('S9.75 extracted wiring boundaries', () => {
  it.each(modules)('%s stays narrow and does not import its facade', (file) => {
    const source = read(file);
    expect(effectiveLines(source)).toBeLessThan(500);
    const forbiddenFacade = file.startsWith('src/host/tools/')
      ? /from ['"][^'"]*\/toolExecutor['"]/
      : file.startsWith('src/web/routes/')
        ? /from ['"]\.\/agent['"]/
        : file.includes('/database/')
          ? /from ['"][^'"]*\/databaseService['"]/
          : /from ['"][^'"]*(multiagentTools\/spawnAgent|\/parallelAgentCoordinator|\/subagentExecutor)['"]/;
    expect(source).not.toMatch(forbiddenFacade);
  });

  it('keeps Native model and tool checkpoints fail-closed', () => {
    const model = read('src/host/agent/runtime/contextAssembly/nativeModelCheckpoint.ts');
    const tool = read('src/host/tools/nativeToolCheckpoint.ts');
    expect(model).toContain('requires a stable source message id');
    expect(model).toContain("status === 'succeeded'");
    expect(tool).toContain('requires a stable source message id');
    expect(tool).toContain('providerOperationId: input.executionId');
    expect(tool).toContain("status: success ? 'succeeded' : 'failed'");
  });

  it('keeps Durable route reads and terminal lifecycle in extracted helpers', () => {
    const lifecycle = read('src/web/routes/agentDurableRouteLifecycle.ts');
    const cancel = read('src/web/routes/registerAgentCancelRoute.ts');
    expect(lifecycle).toContain('DURABLE_RUN_ROLLOUT_UNAVAILABLE');
    expect(lifecycle).toContain('releaseDurable');
    expect(lifecycle).toContain("view.source === 'durable' && view.terminal");
    expect(cancel).toContain('isDurableTerminalNativeControl');
  });

  it('keeps Graph, recovery, approval, and protocol ownership in one direction', () => {
    expect(read('src/host/agent/agentTeamGraphCompatibility.ts'))
      .toContain('new GraphEventCompatibilityAdapter');
    expect(read('src/host/agent/parallelAgentDurableRecovery.ts'))
      .toContain("classification === 'reuse_completed'");
    expect(read('src/host/agent/agentTeamDurableLaunch.ts'))
      .toContain('markApprovalWaiting');
    expect(read('src/host/agent/subagentToolRuntime.ts'))
      .toContain('context.permission.request(request)');
  });
});
