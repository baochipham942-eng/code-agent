// ============================================================================
// N-ACCEPTEDITS-EXTERNAL-ASK ⑧：acceptEdits 下出站工具的真模型端到端
// ============================================================================
// 真实 ToolExecutor + 真实 resolveToolPermissionClassification（不 mock 分类器）；
// 工具调用由真实 GLM 模型产生（ZHIPU_CODING_API_KEY，OpenAI 兼容 coding 端点，glm-5.3）。
// requestPermission 一律回 false：绝不真发邮件 / 真建会议，只证明「会被询问」。
// 默认 skip；ACCEPT_EDITS_REAL_MODEL=1 才真跑（CI 无 key 时静默跳过）。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { config as loadDotenv } from 'dotenv';

const RUN_REAL_MODEL = process.env.ACCEPT_EDITS_REAL_MODEL === '1';

const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'acceptedits-e2e-'));
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

// 与 tests/eval/writebackOneCard.test.ts 同款六模块 mock：resolver 控工具面，其余保 hermetic。
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
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
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

loadDotenv({ path: nodePath.join(process.cwd(), '.env'), quiet: true });
loadDotenv({ path: nodePath.join(process.env.HOME ?? '', '.code-agent', '.env'), quiet: true });

import { buildPrompt } from '../../src/host/prompts/builder';
import { mailSendSchema } from '../../src/host/tools/modules/connectors/mailSend.schema';
import { tmeetMeetingCreateSchema } from '../../src/host/tools/modules/connectors/tmeetMeetingCreate.schema';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import { OpenAIProvider } from '../../src/host/model/providers/openaiProvider';
import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../src/host/permissions/modes';
import type { PermissionRequestData } from '../../src/host/tools/types';
import type { ModelConfig, ToolDefinition } from '../../src/shared/contract';

interface E2ERun {
  prompt: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> | undefined }>;
  approvalRequests: PermissionRequestData[];
  finishReason?: string;
  execution?: { success: boolean; error?: string };
}

async function runUnderAcceptEdits(userPrompt: string): Promise<E2ERun> {
  const apiKey = process.env.ZHIPU_CODING_API_KEY?.trim();
  if (!apiKey) throw new Error('ZHIPU_CODING_API_KEY missing (~/.code-agent/.env)');

  const provider = new OpenAIProvider();
  const response = await provider.inference(
    [
      { role: 'system', content: buildPrompt() },
      { role: 'user', content: userPrompt },
    ],
    [mailSendSchema as ToolDefinition, tmeetMeetingCreateSchema as ToolDefinition],
    {
      provider: 'openai',
      model: 'glm-5.3',
      apiKey,
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      temperature: 0,
      maxTokens: 4096,
    } as ModelConfig,
    undefined,
    undefined,
    {
      forceNonStreaming: true,
      disableProviderTransientRetry: true,
      requestTimeoutMs: 60_000,
      maxOutputTokens: 4096,
    },
  );

  const call = response.toolCalls?.[0];
  const approvalRequests: PermissionRequestData[] = [];
  if (!call) {
    return { prompt: userPrompt, toolCalls: [], approvalRequests, finishReason: response.finishReason, execution: undefined };
  }

  getPermissionModeManager().setMode('acceptEdits');
  const executor = new ToolExecutor({
    workingDirectory: '/tmp/acceptedits-e2e',
    requestPermission: async (request) => {
      approvalRequests.push(request);
      return false; // 拒绝：绝不真发邮件 / 真建会议
    },
  });
  executor.setAuditEnabled(false);
  const execResult = await executor.execute(call.name, call.arguments ?? {}, { sessionId: 'acceptedits-e2e' });
  return {
    prompt: userPrompt,
    toolCalls: [{ name: call.name, arguments: call.arguments }],
    approvalRequests,
    finishReason: response.finishReason,
    execution: { success: execResult.success, error: execResult.error },
  };
}

const runs: E2ERun[] = [];

(RUN_REAL_MODEL ? describe : describe.skip)('N-ACCEPTEDITS-EXTERNAL-ASK real-model e2e', () => {
  beforeEach(() => {
    resetPermissionModeManager();
    fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
    resolverState.getDefinition.mockReset();
    // 真实注册层会按 permissionLevel 包一层 requiresPermission；mock resolver 直接回裸
    // schema 会被 executor 前置直通，照 writebackOneCard 的 CREATE_DEFINITION 补齐。
    resolverState.getDefinition.mockImplementation((name: string) => (
      name === 'mail_send' ? { ...mailSendSchema, requiresPermission: true }
        : name === 'tmeetMeetingCreate' ? { ...tmeetMeetingCreateSchema, requiresPermission: true }
          : undefined
    ));
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it('"email a@example.com that the meeting moved" 必须落到 mail_send 审批卡而非静默发送', { timeout: 180_000 }, async () => {
    const run = await runUnderAcceptEdits('Email a@example.com that the meeting moved to 3pm.');
    runs.push(run);
    expect(run.toolCalls[0]?.name).toBe('mail_send');
    expect(run.approvalRequests.length).toBe(1);
    expect(run.approvalRequests[0]?.tool).toBe('mail_send');
  });

  it('"create a meeting starting now" 必须落到 tmeetMeetingCreate 审批卡', { timeout: 180_000 }, async () => {
    const run = await runUnderAcceptEdits('Create a meeting starting now.');
    runs.push(run);
    expect(run.toolCalls[0]?.name).toBe('tmeetMeetingCreate');
    expect(run.approvalRequests.length).toBe(1);
    expect(run.approvalRequests[0]?.tool).toBe('tmeetMeetingCreate');
  });

  afterAll(() => {
    if (runs.length === 0) return;
    const outPath = nodePath.join(
      process.env.HOME ?? '', 'work', 'out', 'N-ACCEPTEDITS-EXTERNAL-ASK', 'e2e-approvalRequests.json',
    );
    fs.writeFileSync(outPath, JSON.stringify(runs, null, 2), 'utf-8');
    process.stdout.write(`E2E_RAW_OUTPUT_WRITTEN=${outPath}\n`);
  });
});
