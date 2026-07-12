import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUBAGENT_EXECUTOR_PATH = path.resolve(
  __dirname,
  '../../../src/host/agent/subagentExecutor.ts',
);
const SUBAGENT_TOOL_RUNTIME_PATH = path.resolve(
  __dirname,
  '../../../src/host/agent/subagentToolRuntime.ts',
);

describe('SubagentExecutor Agent Team scope propagation', () => {
  const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');
  const toolRuntimeSource = readFileSync(SUBAGENT_TOOL_RUNTIME_PATH, 'utf8');

  it('uses the caller composite execution identity for child tool context', () => {
    expect(source).toMatch(
      /const executionAgentId\s*=\s*context\.executionAgentId\s*\|\|\s*context\.spawnGuardId\s*\|\|\s*pipelineContext\.agentId/,
    );
    expect(source).toMatch(
      /subagentToolExecutor\.execute\([\s\S]*?agentId:\s*executionAgentId,[\s\S]*?swarmRunScope:\s*context\.swarmRunScope/,
    );
    expect(source).toMatch(
      /subagentToolExecutor\.execute\([\s\S]*?runId:\s*context\.runId,[\s\S]*?swarmRunScope:\s*context\.swarmRunScope/,
    );
    expect(toolRuntimeSource).toMatch(
      /createRunContext\(\{[\s\S]*?runId:\s*context\.runId,[\s\S]*?sessionId:\s*input\.sessionId,[\s\S]*?workspace:\s*context\.workspace,[\s\S]*?cwd:\s*context\.cwd/,
    );
  });

  it('submits high-risk plans with the same scoped identity and run scope', () => {
    expect(source).toMatch(
      /gate\.submitForApproval\(\{[\s\S]*?agentId:\s*executionAgentId,[\s\S]*?scope:\s*context\.swarmRunScope/,
    );
    expect(source).toMatch(/if \(effectiveSignal\.aborted\)[\s\S]*?Task cancelled after plan approval/);
  });

  it('returns and emits the stable execution identity instead of the pipeline id', () => {
    expect(source).toMatch(/agent_thinking[\s\S]*?agentId:\s*executionAgentId/);
    expect(source).not.toMatch(/agentId:\s*agentTask\.id/);
  });
});
