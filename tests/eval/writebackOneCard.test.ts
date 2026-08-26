import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

vi.mock('../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildPrompt } from '../../src/host/prompts/builder';
import { askUserQuestionSchema } from '../../src/host/tools/modules/planning/askUserQuestion.schema';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../src/host/tools/types';

interface ToolCall {
  name: 'AskUserQuestion' | 'tmeetMeetingCreate';
  args: Record<string, unknown>;
}

interface ScenarioReplay {
  toolCalls: ToolCall[];
  approvalRequests: PermissionRequestData[];
}

const CREATE_DEFINITION = {
  name: 'tmeetMeetingCreate',
  description: 'create Tencent Meeting',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
    },
    required: ['subject', 'start', 'end'],
  },
  requiresPermission: true,
  permissionLevel: 'write',
};

/**
 * Deterministic provider for this contract eval: it follows the two model-visible
 * contract surfaces exactly, so removing either surface replays the old double-card path.
 */
function mockProvider(systemPrompt: string, askToolDescription: string): ToolCall {
  const systemContractPresent = systemPrompt.includes(
    'NEVER use AskUserQuestion to collect fields',
  ) && systemPrompt.includes('tmeetMeetingCreate with a short default subject');
  const toolContractPresent = askToolDescription.includes(
    'Never collect approval-gated writeback fields',
  ) && askToolDescription.includes(
    'approval card is the edit point',
  );

  if (!systemContractPresent || !toolContractPresent) {
    return {
      name: 'AskUserQuestion',
      args: {
        questions: [{
          header: '会议信息',
          question: '会议主题和时长是什么？',
          options: [
            { label: '快速会议', description: '使用常见默认值' },
            { label: '自定义', description: '继续收集字段' },
          ],
        }],
      },
    };
  }

  return {
    name: 'tmeetMeetingCreate',
    args: {
      subject: '快速会议',
      start: '2026-08-26T09:00:00+08:00',
      end: '2026-08-26T09:30:00+08:00',
    },
  };
}

async function replayScenario(
  systemPrompt: string,
  askToolDescription: string,
): Promise<ScenarioReplay> {
  const call = mockProvider(systemPrompt, askToolDescription);
  const approvalRequests: PermissionRequestData[] = [];
  if (call.name === 'AskUserQuestion') return { toolCalls: [call], approvalRequests };

  const executor = new ToolExecutor({
    workingDirectory: '/tmp/writeback-one-card-eval',
    requestPermission: async (request) => {
      approvalRequests.push(request);
      return false;
    },
  });
  executor.setAuditEnabled(false);
  await executor.execute(call.name, call.args, { sessionId: 'writeback-one-card-eval' });
  return { toolCalls: [call], approvalRequests };
}

function gateFailures(replay: ScenarioReplay): string[] {
  const failures: string[] = [];
  const askCount = replay.toolCalls.filter((call) => call.name === 'AskUserQuestion').length;
  if (askCount !== 0) failures.push(`AskUserQuestion count expected 0, received ${askCount}`);
  if (replay.approvalRequests.length !== 1) {
    failures.push(`approval count expected 1, received ${replay.approvalRequests.length}`);
  } else if (replay.approvalRequests[0]?.tool !== 'tmeetMeetingCreate') {
    failures.push(`approval tool expected tmeetMeetingCreate, received ${replay.approvalRequests[0]?.tool}`);
  }
  return failures;
}

describe('N-WRITEBACK-ONECARD deterministic contract eval', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.getDefinition.mockImplementation((name: string) => (
      name === 'tmeetMeetingCreate' ? CREATE_DEFINITION : undefined
    ));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'meeting created' });
  });

  it('“创建一场会议，马上开始”不提问，直接进入腾讯会议审批且不真创建', async () => {
    const replay = await replayScenario(
      buildPrompt(),
      askUserQuestionSchema.description,
    );

    expect(gateFailures(replay)).toEqual([]);
    expect(replay.toolCalls).toEqual([
      expect.objectContaining({ name: 'tmeetMeetingCreate' }),
    ]);
    expect(replay.approvalRequests[0]).toMatchObject({
      tool: 'tmeetMeetingCreate',
      forceConfirm: true,
      boundary: { id: 'connector.external_write' },
      decisionTrace: {
        steps: expect.arrayContaining([
          expect.objectContaining({ rule: 'C1: connector_external_write', result: 'ask' }),
        ]),
      },
    });
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('反向变异：删除 system/schema 合同后，同一门明确变红', async () => {
    const mutatedPrompt = buildPrompt().replace(
      /<writeback_one_card>[\s\S]*?<\/writeback_one_card>/u,
      '',
    );
    const mutatedDescription = 'Asks the user a question and waits for their response. '
      + 'Use when you need clarification, confirmation, or additional information to proceed.';
    const replay = await replayScenario(mutatedPrompt, mutatedDescription);

    expect(gateFailures(replay)).toEqual([
      'AskUserQuestion count expected 0, received 1',
      'approval count expected 1, received 0',
    ]);
  });
});
