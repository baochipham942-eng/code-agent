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

// 源码文本断言对格式化敏感：一次折行就能让 toContain 假红，而代码语义一个字没变。
// 2026-07-31 #864 把 `view.source === 'durable' && view.terminal` 折成三行，
// main 全量门因此从那天起连红 100 次运行。断言前把连续空白折成单空格，
// 只比对 token 序列，不比对排版。（effectiveLines 仍读原始源码，它数的就是行。）
const flat = (source: string) => source.replace(/\s+/g, ' ');

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
    expect(flat(model)).toContain('requires a stable source message id');
    expect(flat(model)).toContain("status === 'succeeded'");
    expect(flat(tool)).toContain('requires a stable source message id');
    expect(flat(tool)).toContain('providerOperationId: input.executionId');
    expect(flat(tool)).toContain("status: success ? 'succeeded' : 'failed'");
  });

  it('keeps Durable route reads and terminal lifecycle in extracted helpers', () => {
    const lifecycle = flat(read('src/web/routes/agentDurableRouteLifecycle.ts'));
    const cancel = flat(read('src/web/routes/registerAgentCancelRoute.ts'));
    expect(lifecycle).toContain('DURABLE_RUN_ROLLOUT_UNAVAILABLE');
    expect(lifecycle).toContain('releaseDurable');
    expect(lifecycle).toContain("view.source === 'durable' && view.terminal");
    expect(cancel).toContain('isDurableTerminalNativeControl');
  });

  it('keeps Graph, recovery, approval, and protocol ownership in one direction', () => {
    expect(flat(read('src/host/agent/agentTeamGraphCompatibility.ts')))
      .toContain('new GraphEventCompatibilityAdapter');
    expect(flat(read('src/host/agent/parallelAgentDurableRecovery.ts')))
      .toContain("classification === 'reuse_completed'");
    expect(flat(read('src/host/agent/agentTeamDurableLaunch.ts')))
      .toContain('markApprovalWaiting');
    expect(flat(read('src/host/agent/subagentToolRuntime.ts')))
      .toContain('context.permission.request(request)');
  });
});
