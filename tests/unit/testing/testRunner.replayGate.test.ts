import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/main/testing/testRunner';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';

const telemetryMocks = vi.hoisted(() => ({
  getStructuredReplay: vi.fn(),
}));
const databaseMocks = vi.hoisted(() => ({
  insertExperiment: vi.fn(),
  insertExperimentCases: vi.fn(),
}));

vi.mock('../../../src/main/evaluation/telemetryQueryService', () => ({
  getTelemetryQueryService: () => ({
    getStructuredReplay: telemetryMocks.getStructuredReplay,
  }),
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => databaseMocks,
}));

function createToolDistribution(): StructuredReplay['summary']['toolDistribution'] {
  return {
    Read: 1,
    Edit: 0,
    Write: 0,
    Bash: 0,
    Search: 0,
    Web: 0,
    Agent: 0,
    Skill: 0,
    Other: 0,
  };
}

function createReplay(
  sessionId: string,
  overrides: Partial<StructuredReplay> = {}
): StructuredReplay {
  const replay: StructuredReplay = {
    sessionId,
    traceIdentity: {
      traceId: `session:${sessionId}`,
      traceSource: 'session_replay',
      source: 'session_replay',
      sessionId,
      replayKey: sessionId,
    },
    traceSource: 'session_replay',
    dataSource: 'telemetry',
    turns: [
      {
        turnNumber: 1,
        blocks: [
          {
            type: 'model_call',
            content: 'mock/model: tool_use',
            timestamp: 110,
            modelDecision: {
              id: 'model-1',
              provider: 'mock',
              model: 'model',
              responseType: 'tool_use',
              toolCallCount: 1,
              inputTokens: 10,
              outputTokens: 8,
              latencyMs: 12,
              prompt: 'read a file',
              completion: 'calling read_file',
              toolSchemas: [
                {
                  name: 'read_file',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          },
          {
            type: 'tool_call',
            content: 'read_file',
            timestamp: 120,
            toolCall: {
              id: 'tool-1',
              name: 'read_file',
              args: { file_path: 'src/main.ts' },
              actualArgs: { file_path: 'src/main.ts' },
              argsSource: 'telemetry_actual',
              result: 'ok',
              success: true,
              successKnown: true,
              duration: 8,
              category: 'Read',
              toolSchema: {
                name: 'read_file',
                inputSchema: { type: 'object' },
              },
            },
          },
          {
            type: 'event',
            content: 'tool schema available',
            timestamp: 105,
            event: {
              eventType: 'tool_schema_snapshot',
              summary: '1 tool schemas available',
            },
          },
        ],
        inputTokens: 10,
        outputTokens: 8,
        durationMs: 50,
        startTime: 100,
      },
    ],
    summary: {
      totalTurns: 1,
      toolDistribution: createToolDistribution(),
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 50,
      metricAvailability: {
        dataSource: 'telemetry',
        replaySource: 'telemetry',
        toolDistribution: 'telemetry',
        selfRepair: 'telemetry',
        actualArgs: 'telemetry',
      },
      telemetryCompleteness: {
        sessionId,
        replayKey: sessionId,
        turnCount: 1,
        modelCallCount: 1,
        toolCallCount: 1,
        eventCount: 1,
        hasSessionId: true,
        hasModelDecisions: true,
        hasToolSchemas: true,
        hasPermissionTrace: false,
        hasContextCompressionEvents: false,
        hasSubagentTelemetry: false,
        hasRealAgentTrace: true,
        dataSource: 'telemetry',
        incompleteReasons: [],
      },
    },
  };
  return { ...replay, ...overrides };
}

function createRunner(sessionId = 'session-gate'): TestRunner {
  const agent: AgentInterface = {
    sendMessage: vi.fn(async () => ({
      responses: ['ok'],
      toolExecutions: [
        {
          tool: 'read_file',
          input: { file_path: 'src/main.ts' },
          output: 'ok',
          success: true,
          duration: 8,
          timestamp: 120,
        },
      ],
      turnCount: 1,
      errors: [],
    })),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
    getSessionId: () => sessionId,
    finalizeSession: vi.fn(async () => undefined),
  };

  return new TestRunner({
    testCaseDir: '/tmp/code-agent-tests',
    resultsDir: '/tmp/code-agent-results',
    workingDirectory: '/tmp',
    defaultTimeout: 1000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, agent);
}

describe('TestRunner real-agent-run replay gate', () => {
  beforeEach(() => {
    telemetryMocks.getStructuredReplay.mockReset();
    databaseMocks.insertExperiment.mockReset();
    databaseMocks.insertExperimentCases.mockReset();
  });

  it('passes real-agent-run cases when telemetry replay has model, schema, tool, and event evidence', async () => {
    telemetryMocks.getStructuredReplay.mockResolvedValue(createReplay('session-gate'));
    const runner = createRunner();

    const result = await runner.runSingleTest({
      id: 'real-agent-pass',
      type: 'task',
      description: 'real agent pass',
      prompt: 'read a file',
      expect: { response_contains: ['ok'] },
      tags: ['real-agent-run'],
    });

    expect(result.status).toBe('passed');
    expect(result.replayKey).toBe('session-gate');
    expect(result.telemetryCompleteness?.hasRealAgentTrace).toBe(true);
    expect(result.telemetryGate).toEqual({
      name: 'real-agent-run',
      passed: true,
      failures: [],
    });
  });

  it('fails real-agent-run cases when replay only has transcript fallback evidence', async () => {
    telemetryMocks.getStructuredReplay.mockResolvedValue(createReplay('session-gate', {
      dataSource: 'transcript_fallback',
      summary: {
        ...createReplay('session-gate').summary,
        metricAvailability: {
          dataSource: 'transcript_fallback',
          replaySource: 'transcript_fallback',
          toolDistribution: 'transcript',
          selfRepair: 'transcript',
          actualArgs: 'transcript',
        },
        telemetryCompleteness: {
          sessionId: 'session-gate',
          replayKey: 'session-gate',
          turnCount: 1,
          modelCallCount: 0,
          toolCallCount: 1,
          eventCount: 0,
          hasSessionId: true,
          hasModelDecisions: false,
          hasToolSchemas: false,
          hasPermissionTrace: false,
          hasContextCompressionEvents: false,
          hasSubagentTelemetry: false,
          hasRealAgentTrace: false,
          dataSource: 'transcript_fallback',
          incompleteReasons: ['transcript_fallback_replay', 'missing_model_decisions', 'missing_tool_schemas'],
        },
      },
    }));
    const runner = createRunner();

    const result = await runner.runSingleTest({
      id: 'real-agent-fallback',
      type: 'task',
      description: 'real agent fallback fails',
      prompt: 'read a file',
      expect: { response_contains: ['ok'] },
      tags: ['real-agent-run'],
    });

    expect(result.status).toBe('failed');
    expect(result.score).toBe(0);
    expect(result.failureStage).toBe('telemetry_replay_gate');
    expect(result.telemetryGate?.failures).toEqual(expect.arrayContaining([
      'transcript_fallback_replay',
      'missing_model_decisions',
      'missing_tool_schemas',
      'missing_real_agent_trace',
    ]));
  });

  it('keeps multi-trial real-agent-run summaries failed when any trial fails the telemetry gate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-replay-gate-'));
    const casesDir = path.join(root, 'cases');
    const resultsDir = path.join(root, 'results');
    await mkdir(casesDir, { recursive: true });
    await writeFile(path.join(casesDir, 'suite.yaml'), [
      'name: replay-gate',
      'cases:',
      '  - id: real-agent-multi',
      '    type: task',
      '    description: real agent multi trial',
      '    prompt: read a file',
      '    tags: [real-agent-run]',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));

    const failingReplay = createReplay('session-gate-fail', {
      dataSource: 'transcript_fallback',
      summary: {
        ...createReplay('session-gate-fail').summary,
        metricAvailability: {
          dataSource: 'transcript_fallback',
          replaySource: 'transcript_fallback',
          toolDistribution: 'transcript',
          selfRepair: 'transcript',
          actualArgs: 'transcript',
        },
        telemetryCompleteness: {
          sessionId: 'session-gate-fail',
          replayKey: 'session-gate-fail',
          turnCount: 1,
          modelCallCount: 0,
          toolCallCount: 1,
          eventCount: 0,
          hasSessionId: true,
          hasModelDecisions: false,
          hasToolSchemas: false,
          hasPermissionTrace: false,
          hasContextCompressionEvents: false,
          hasSubagentTelemetry: false,
          hasRealAgentTrace: false,
          dataSource: 'transcript_fallback',
          incompleteReasons: ['transcript_fallback_replay', 'missing_model_decisions'],
        },
      },
    });
    telemetryMocks.getStructuredReplay
      .mockResolvedValueOnce(failingReplay)
      .mockResolvedValueOnce(createReplay('session-pass-1'))
      .mockResolvedValueOnce(createReplay('session-pass-2'));

    const sessionIds = ['session-gate-fail', 'session-pass-1', 'session-pass-2'];
    let currentSessionId = sessionIds[0];
    let sendCount = 0;
    const agent: AgentInterface = {
      sendMessage: vi.fn(async () => {
        currentSessionId = sessionIds[sendCount] ?? sessionIds[sessionIds.length - 1];
        sendCount += 1;
        return {
          responses: ['ok'],
          toolExecutions: [
            {
              tool: 'read_file',
              input: { file_path: 'src/main.ts' },
              output: 'ok',
              success: true,
              duration: 8,
              timestamp: 120,
            },
          ],
          turnCount: 1,
          errors: [],
        };
      }),
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
      getSessionId: () => currentSessionId,
      finalizeSession: vi.fn(async () => undefined),
    };

    try {
      const runner = new TestRunner({
        testCaseDir: casesDir,
        resultsDir,
        workingDirectory: root,
        defaultTimeout: 1000,
        stopOnFailure: false,
        verbose: false,
        parallel: false,
        maxParallel: 1,
        enableEvalCritic: false,
        trialsPerCase: 3,
      }, agent);

      const summary = await runner.runAll();
      const result = summary.results[0];

      expect(summary.passed).toBe(0);
      expect(summary.failed).toBe(1);
      expect(result.status).toBe('failed');
      expect(result.score).toBe(0);
      expect(result.failureReason).toContain('real-agent-run gate failed');
      expect(result.trials).toHaveLength(3);
      expect(result.trials?.[0]).toMatchObject({
        status: 'failed',
        sessionId: 'session-gate-fail',
        replayKey: 'session-gate-fail',
        failureStage: 'telemetry_replay_gate',
        telemetryGate: {
          passed: false,
          failures: expect.arrayContaining(['transcript_fallback_replay', 'missing_model_decisions']),
        },
      });
      expect(result.trials?.[0].failureReason).toContain('real-agent-run gate failed');
      expect(result.trials?.[1]).toMatchObject({
        status: 'passed',
        sessionId: 'session-pass-1',
        replayKey: 'session-pass-1',
        telemetryGate: {
          passed: true,
          failures: [],
        },
      });
      expect(result.trials?.[2]).toMatchObject({
        status: 'passed',
        sessionId: 'session-pass-2',
        replayKey: 'session-pass-2',
        telemetryGate: {
          passed: true,
          failures: [],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
