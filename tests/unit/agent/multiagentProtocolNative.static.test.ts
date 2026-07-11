import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

const protocolEntryFiles = [
  'src/host/tools/modules/multiagent/task.ts',
  'src/host/tools/modules/multiagent/spawnAgent.ts',
  'src/host/tools/modules/multiagent/workflowOrchestrate.ts',
];

describe('multiagent protocol-native production paths', () => {
  it.each(protocolEntryFiles)('%s does not depend on legacy context/result adapters', (relativePath) => {
    const source = readFileSync(resolve(ROOT, relativePath), 'utf8');

    expect(source).not.toContain('buildLegacyCtxFromProtocol');
    expect(source).not.toContain('executeSpawnAgentLegacy');
    expect(source).not.toContain('executeWorkflowOrchestrateLegacy');
  });

  it('SubagentExecutor port does not import or expose legacy ToolContext', () => {
    const source = readFileSync(
      resolve(ROOT, 'src/host/agent/subagentExecutorPort.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/from ['"]\.\.\/tools\/types['"]/);
    expect(source).not.toContain('SubagentContext');
    expect(source).toContain('SubagentExecutionRequest');
  });

  it('SubagentExecutor uses the injected trace context instead of process-global trace identity', () => {
    const source = readFileSync(
      resolve(ROOT, 'src/host/agent/subagentExecutor.ts'),
      'utf8',
    );

    expect(source).not.toContain('getActiveRunTraceContext');
    expect(source).toContain('context.traceContext');
  });

  it('ParallelAgentCoordinator stores the execution port context, not a tool context', () => {
    const source = readFileSync(
      resolve(ROOT, 'src/host/agent/parallelAgentCoordinator.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/import type \{ ToolContext \} from ['"]\.\.\/tools\/types['"]/);
    expect(source).not.toMatch(/private toolContext\??:/);
    expect(source).toContain('SubagentExecutionContext');
  });
});
