#!/usr/bin/env npx tsx

import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import process from 'process';

const MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fail(message: string, details?: unknown): never {
  const suffix = details === undefined ? '' : `\n${asJson(details)}`;
  throw new Error(`${message}${suffix}`);
}

async function main(): Promise<void> {
  const json = hasFlag('--json');
  const keepTmp = hasFlag('--keep-tmp') || process.env.CODE_AGENT_ACCEPTANCE_KEEP_TMP === '1';
  const repoRoot = process.cwd();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agent-neo-real-agent-replay-eval-'));
  const workspaceDir = path.join(dataDir, 'workspace');
  const testCaseDir = path.join(dataDir, 'test-cases');
  const resultsDir = path.join(dataDir, 'test-results');
  const fixturePath = path.join(workspaceDir, 'e2e-agent-replay-eval-target.txt');

  try {
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(testCaseDir, { recursive: true });
    await writeFile(
      fixturePath,
      [
        `${MARKER}=true`,
        'This file proves the real AgentLoop reached the real Read tool executor.',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(testCaseDir, 'real-agent-replay-eval-smoke.yaml'),
      asJson({
        name: 'real-agent-replay-eval-smoke',
        description: 'Real AgentLoop tool execution must produce structured replay evidence for eval.',
        default_timeout: 30000,
        cases: [
          {
            id: 'real-agent-replay-eval-smoke',
            type: 'task',
            description: 'Read a fixture through the real AgentLoop and satisfy the replay eval gate.',
            prompt: `Use the Read tool to inspect ${fixturePath}, then report the marker exactly.`,
            tags: ['smoke', 'real-agent-run'],
            timeout: 30000,
            expect: {
              tool: 'Read',
              success: true,
              args_match: {
                file_path: fixturePath,
              },
              output_contains: [MARKER],
              response_contains: [
                'E2E real agent replay eval smoke completed',
                MARKER,
              ],
              min_tool_calls: 1,
              max_tool_calls: 1,
              max_turns: 3,
            },
          },
        ],
      }),
      'utf8',
    );

    process.env.CODE_AGENT_DATA_DIR = dataDir;
    process.env.CODE_AGENT_E2E = '1';
    process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL = '1';
    process.env.CODE_AGENT_E2E_AGENT_MODEL_READ_FILE = fixturePath;
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
    process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';

    const { getProtocolRegistry } = await import('../../src/main/tools/protocolRegistry');
    getProtocolRegistry();

    const { getDatabase } = await import('../../src/main/services/core/databaseService');
    const testing = await import('../../src/main/testing/index');
    const { getTelemetryQueryService } = await import('../../src/main/evaluation/telemetryQueryService');
    const { buildAgentTrajectoryFromReplay } = await import('../../src/main/evaluation/trajectory/trajectoryExporter');

    await getDatabase().initialize();

    const config = testing.createDefaultConfig(repoRoot, {
      testCaseDir,
      resultsDir,
      workingDirectory: workspaceDir,
      defaultTimeout: 30000,
      stopOnFailure: true,
      verbose: false,
      parallel: false,
      maxParallel: 1,
      enableEvalCritic: false,
      toolMode: 'deferred',
    });

    const agent = new testing.StandaloneAgentAdapter({
      workingDirectory: workspaceDir,
      generation: 'e2e-real-agent-replay-eval',
      modelConfig: {
        provider: 'openai',
        model: 'e2e-local-agent-model',
        apiKey: 'e2e-local',
      },
      toolMode: 'deferred',
    });

    const runner = new testing.TestRunner(config, agent);
    const summary = await runner.runAll();
    const result = summary.results[0];
    if (summary.total !== 1 || !result) {
      fail('Expected exactly one eval smoke result.', { total: summary.total });
    }
    if (result.status !== 'passed') {
      fail('Real agent replay/eval smoke failed.', result);
    }
    if (result.telemetryGate?.passed !== true) {
      fail('real-agent-run telemetry gate did not pass.', result.telemetryGate);
    }
    if (!result.sessionId || !result.replayKey) {
      fail('Smoke result is missing sessionId or replayKey.', {
        sessionId: result.sessionId,
        replayKey: result.replayKey,
      });
    }

    const replay = await getTelemetryQueryService().getStructuredReplay(result.sessionId);
    const blocks = replay?.turns.flatMap((turn) => turn.blocks) ?? [];
    const modelBlock = blocks.find((block) => block.type === 'model_call' && block.modelDecision);
    const toolBlock = blocks.find((block) => block.type === 'tool_call' && block.toolCall?.name === 'Read');
    if (!replay || replay.dataSource !== 'telemetry') {
      fail('Structured replay did not come from telemetry.', replay);
    }
    if (!modelBlock?.modelDecision?.toolSchemas?.some((schema) => schema.name === 'Read')) {
      fail('Structured replay is missing the Read tool schema on model decision.', modelBlock);
    }
    if (!toolBlock?.toolCall?.successKnown || !String(toolBlock.toolCall.result ?? '').includes(MARKER)) {
      fail('Structured replay is missing the successful Read tool result.', toolBlock);
    }
    const trajectory = buildAgentTrajectoryFromReplay(replay);
    if (trajectory.quality.tier !== 'G2' || !trajectory.quality.exportReady) {
      fail('Agent trajectory did not pass the G2 export gate.', trajectory.quality);
    }
    if (trajectory.summary.toolCallCount !== trajectory.summary.toolResultCount) {
      fail('Agent trajectory has unpaired tool calls/results.', trajectory.summary);
    }

    const output = {
      ok: true,
      dataDir: keepTmp ? dataDir : undefined,
      sessionId: result.sessionId,
      replayKey: result.replayKey,
      status: result.status,
      telemetryGate: result.telemetryGate,
      trajectoryGate: trajectory.quality,
      telemetryCompleteness: result.telemetryCompleteness,
      toolExecutions: result.toolExecutions.map((tool) => ({
        tool: tool.tool,
        success: tool.success,
        input: tool.input,
        outputContainsMarker: tool.output.includes(MARKER),
      })),
      replay: {
        turns: replay.turns.length,
        dataSource: replay.dataSource,
        modelBlocks: blocks.filter((block) => block.type === 'model_call').length,
        toolBlocks: blocks.filter((block) => block.type === 'tool_call').length,
        hasReadSchema: true,
        hasReadResult: true,
        trajectorySteps: trajectory.steps.length,
        trajectoryTier: trajectory.quality.tier,
      },
    };

    if (json) {
      console.log(asJson(output));
    } else {
      console.log('Real agent replay/eval smoke passed');
      console.log(asJson(output));
    }
  } finally {
    if (!keepTmp) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
