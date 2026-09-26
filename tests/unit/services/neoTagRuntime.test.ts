import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import type {
  NeoModelIntent,
  NeoWorkCard,
  NeoWorkCardDelta,
  NeoWorkCardDetail,
  NeoWorkCardRevision,
} from '../../../src/shared/contract/tag';
import { resolveNeoTagModelIntent } from '../../../src/host/services/project/neoTagModelIntentResolver';
import { buildNeoTagContextPack } from '../../../src/host/services/project/neoTagContextSelector';
import { buildNeoTagPromptLayer } from '../../../src/host/services/project/neoTagPromptLayer';
import {
  createAndRunNeoWorkCard,
  launchApprovedNeoWorkCard,
  type NeoTagTaskManager,
} from '../../../src/host/services/project/neoTagRuntimeService';
import type { NeoWorkCardService } from '../../../src/host/services/project/neoWorkCardService';
import type { CreateNeoWorkCardDraftInput } from '../../../src/shared/contract/tag';
import type { AppSettings } from '../../../src/shared/contract/settings';
import { TASK_QUEUE_TIMEOUTS } from '../../../src/shared/constants';

const sessionMessages: Message[] = [];
let sessionWorkingDirectory: string | undefined = '/repo/project';
// 按 sessionId 区分的会话数据（跨会话用例用）；未注册的 sessionId 走上面的全局兜底，既有用例不受影响。
const sessionsById = new Map<string, { workingDirectory?: string; messages: Message[] }>();
const tempDirs: string[] = [];

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      workingDirectory: sessionsById.get(sessionId)?.workingDirectory ?? sessionWorkingDirectory,
      messages: sessionsById.get(sessionId)?.messages ?? sessionMessages,
    })),
  }),
}));

function workCard(overrides: Partial<NeoWorkCard> = {}): NeoWorkCard {
  return {
    id: 'nwc_1',
    projectId: 'proj_1',
    sourceConversationId: 'conv_1',
    sourceTurnId: 'msg_source',
    requesterUserId: 'user_1',
    title: 'Runtime card',
    status: 'approved',
    currentRevisionId: 'rev_1',
    approvedRevisionId: 'rev_1',
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function revision(modelIntent: NeoModelIntent = { mode: 'inherit_current' }): NeoWorkCardRevision {
  return {
    id: 'rev_1',
    workCardId: 'nwc_1',
    revisionNumber: 1,
    intent: 'implement',
    taskSummary: 'Implement approved runtime wiring',
    readScope: {
      mode: 'selected_context',
      projectId: 'proj_1',
      conversationIds: ['conv_1'],
      messageIds: ['msg_selected'],
      artifactIds: ['artifact_1'],
      fileGlobs: ['src/host/**/*.ts'],
      memoryEntryIds: ['mem_1'],
      notes: ['Read only approved context.'],
    },
    writeScope: {
      mode: 'current_project',
      projectId: 'proj_1',
      allowedPaths: ['src/host/services/project/neoTagRuntimeService.ts'],
      canCreateFiles: true,
      canModifyFiles: true,
      canWriteProjectMemory: false,
      externalDestinations: [],
      notes: ['Write only runtime files.'],
    },
    modelIntent,
    memoryPlan: {
      mode: 'explicit_only',
      entries: [{ kind: 'decision', text: 'Neo Tag uses local runtime in P0.', sourceMessageIds: ['msg_source'] }],
      notes: ['Candidate only.'],
    },
    expectedOutputs: [{ kind: 'patch', title: 'Runtime wiring' }],
    risks: ['Wrong model override would violate approval.'],
    assumptions: ['Current project workspace is local.'],
    createdByUserId: 'user_1',
    createdAt: 1,
  };
}

async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-tag-runtime-'));
  tempDirs.push(dir);
  return dir;
}

async function writeWorkspaceFile(root: string, relPath: string, content: string): Promise<void> {
  const absolute = path.join(root, relPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

describe('Neo Tag runtime helpers', () => {
  beforeEach(() => {
    sessionMessages.splice(0, sessionMessages.length);
    sessionWorkingDirectory = '/repo/project';
    sessionsById.clear();
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves model intent without letting fixed_model inherit adaptive routing', () => {
    const baseConfig = {
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'base-key',
      adaptive: true,
    };
    const configService = {
      getApiKey: vi.fn((provider: string) => `${provider}-key`),
      getSettings: vi.fn(() => ({
        models: {
          providers: {
            claude: { baseUrl: 'https://claude.example', maxTokens: 12000 },
          },
        },
      } as unknown as AppSettings)),
    };

    expect(resolveNeoTagModelIntent({
      baseConfig,
      modelIntent: { mode: 'inherit_current' },
      configService,
    }).modelConfig).toMatchObject({ provider: 'openai', model: 'gpt-4.1', adaptive: true });

    expect(resolveNeoTagModelIntent({
      baseConfig,
      modelIntent: { mode: 'adaptive_auto', taskStrategy: 'main' },
      configService,
    })).toMatchObject({ modelConfig: { provider: 'openai', model: 'gpt-4.1', adaptive: true }, fixedModel: false });

    expect(resolveNeoTagModelIntent({
      baseConfig,
      modelIntent: { mode: 'fixed_model', provider: 'claude', model: 'claude-sonnet-4' },
      configService,
    })).toMatchObject({
      fixedModel: true,
      modelConfig: {
        provider: 'claude',
        model: 'claude-sonnet-4',
        apiKey: 'claude-key',
        baseUrl: 'https://claude.example',
        adaptive: false,
      },
    });
  });

  /**
   * ai-review R7（Nit）：getDefaultModelByProvider 以前没把 settings 传进去，custom-* 供应商
   * 的回落永远落 DEFAULT_MODELS.chat，没用上「该供应商在设置里配的模型 / 运行时列表第一项」。
   */
  it('adaptive_auto 无模型可继时，回落读 settings 里该供应商配的模型，custom-* 不再落全局默认', () => {
    const configService = {
      getApiKey: vi.fn(() => 'team-key'),
      getSettings: vi.fn(() => ({
        models: {
          providers: {
            'custom-team': { model: 'gpt-5.5' },
          },
        },
      } as unknown as AppSettings)),
    };

    expect(resolveNeoTagModelIntent({
      baseConfig: { provider: 'custom-team', model: '', apiKey: 'base-key', adaptive: true },
      modelIntent: { mode: 'adaptive_auto', taskStrategy: 'main' },
      configService,
    })).toMatchObject({ modelConfig: { provider: 'custom-team', model: 'gpt-5.5', adaptive: true }, fixedModel: false });
  });

  it('builds a bounded context pack with selected files, memory placeholders, and exclusions', () => {
    const messages: Message[] = [
      { id: 'old_1', role: 'user', content: 'old', timestamp: 1 },
      { id: 'old_2', role: 'assistant', content: 'old assistant', timestamp: 2 },
      { id: 'msg_selected', role: 'user', content: 'selected', timestamp: 3 },
      { id: 'recent_1', role: 'assistant', content: 'recent', timestamp: 4 },
      { id: 'msg_source', role: 'user', content: 'source request', timestamp: 5 },
    ];

    const pack = buildNeoTagContextPack({
      workCard: workCard(),
      revision: revision(),
      messages,
      maxMessages: 3,
      now: 10,
    });

    expect(pack.selectedMessages.map((message) => message.id)).toContain('msg_source');
    expect(pack.selectedMessages.map((message) => message.id)).toContain('msg_selected');
    expect(pack.selectedFiles).toEqual([{ path: 'src/host/**/*.ts', reason: 'approved fileGlobs placeholder; runtime may read on demand' }]);
    expect(pack.selectedMemoryEntryIds).toEqual(['mem_1']);
    expect(pack.excluded.map((item) => item.id)).toContain('old_1');
    expect(pack.budget.estimatedTokens).toBeGreaterThan(0);
  });

  it('formats the approved work card into a runtime prompt layer', () => {
    const card = workCard();
    const rev = revision({ mode: 'fixed_model', provider: 'claude', model: 'claude-sonnet-4' });
    const pack = buildNeoTagContextPack({ workCard: card, revision: rev, messages: [], now: 10 });
    const prompt = buildNeoTagPromptLayer({
      runContext: {
        workCardId: card.id,
        projectId: card.projectId,
        sourceConversationId: card.sourceConversationId,
        sourceTurnId: card.sourceTurnId,
        approvedRevisionId: rev.id,
        runId: 'run_1',
        contextPackId: pack.id,
        modelIntent: rev.modelIntent,
        contextPack: pack,
      },
      revision: rev,
    });

    expect(prompt).toContain('<neo-tag-work-card>');
    expect(prompt).toContain('Implement approved runtime wiring');
    expect(prompt).toContain('allowedPaths: src/host/services/project/neoTagRuntimeService.ts');
    expect(prompt).toContain('Neo Tag uses local runtime in P0.');
    expect(prompt).toContain('contextPackId:');
  });

  it('launches an approved work card with runtime metadata and writes real changed files', async () => {
    sessionMessages.splice(0, sessionMessages.length,
      { id: 'msg_source', role: 'user', content: '@neo do runtime', timestamp: 1 },
      { id: 'msg_selected', role: 'assistant', content: 'context', timestamp: 2 },
    );
    const workspace = await createTempWorkspace();
    sessionWorkingDirectory = workspace;
    await writeWorkspaceFile(workspace, 'src/host/services/project/neoTagRuntimeService.ts', 'before');
    const card = workCard();
    const rev = {
      ...revision({ mode: 'fixed_model', provider: 'claude', model: 'claude-sonnet-4' }),
      writeScope: {
        ...revision().writeScope,
        allowedPaths: [
          'src/host/services/project/neoTagRuntimeService.ts',
          'src/host/services/project/neoWorkCardService.ts',
        ],
      },
    };
    const deltas: NeoWorkCardDelta[] = [];
    const statuses: string[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        resultReviews: [],
        memoryCandidates: [],
        deltas,
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        statuses.push(status);
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;
    const liveUpdates: string[] = [];
    const taskManager = {
      getOrCreateCurrentOrchestrator: vi.fn(() => ({ setWorkingDirectory: vi.fn() })),
      setSessionContext: vi.fn(),
      setWorkingDirectory: vi.fn(),
      startTask: vi.fn(async () => {
        await writeWorkspaceFile(workspace, 'src/host/services/project/neoTagRuntimeService.ts', 'after');
        // 真实 run 会把最终 assistant 回复落进会话；完成判定靠这个正向证据。
        sessionMessages.push({ id: 'assistant_final', role: 'assistant', content: '运行完成：已改写 runtime 文件。', timestamp: 3 });
      }),
      getSessionState: vi.fn(() => ({ status: 'idle' })),
    };

    const result = await launchApprovedNeoWorkCard({
      workCardId: card.id,
      service,
      taskManager,
      now: () => 100,
      onWorkCardUpdated: (_workCardId, reason) => liveUpdates.push(reason),
    });

    expect(statuses).toEqual(['queued', 'working', 'in_result_review']);
    expect(liveUpdates).toEqual(['runtime_queued', 'runtime_working', 'runtime_result_review']);
    expect(taskManager.startTask).toHaveBeenCalledWith(
      'conv_1',
      'Implement approved runtime wiring',
      undefined,
      expect.objectContaining({
        mode: 'normal',
        displayContent: '@neo Implement approved runtime wiring',
        neoTag: expect.objectContaining({
          workCardId: card.id,
          approvedRevisionId: rev.id,
          promptLayer: expect.stringContaining('<neo-tag-work-card>'),
        }),
      }),
      expect.objectContaining({
        neoTag: expect.objectContaining({
          workCardId: card.id,
          approvedRevisionId: rev.id,
          runId: result.runId,
          contextPackId: result.context.contextPackId,
          status: 'working',
        }),
      }),
      // clientMessageId 必须用 sourceTurnId：renderer 本地补的用户消息与 host 落库消息同 ID，
      // 任何 reload/合并路径都能按 ID 去重（BUG1：@neo 用户消息不显示）。
      card.sourceTurnId,
    );
    expect(taskManager.setSessionContext).toHaveBeenCalledWith('conv_1', sessionMessages);
    expect(deltas[0].completed[0]).toContain('Queued approved revision');
    expect(deltas[0].decisions.join('\n')).toContain('Context audit: pack=');
    expect(deltas.at(-1)?.changedFiles).toEqual(['src/host/services/project/neoTagRuntimeService.ts']);
    expect(deltas.at(-1)?.decisions.join('\n')).toContain('sources=messages+artifacts+files+memory');
  });

  it('launches into target conversation: startTask/metadata/delta bind to the round conversation, working dir untouched', async () => {
    const targetHistory = [{ id: 'history_B', role: 'user', content: '目标会话已有上下文' } as Message];
    sessionsById.set('conv_B', { workingDirectory: '/repo/other', messages: targetHistory });
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        resultReviews: [],
        memoryCandidates: [],
        deltas,
      })),
      setStatus: vi.fn(() => card),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = { ...input, id: `delta_${deltas.length + 1}`, createdAt: deltas.length + 1 } as NeoWorkCardDelta;
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;
    const startTask = vi.fn(async () => {});
    const setWorkingDirectory = vi.fn();
    const orchestratorSetWd = vi.fn();
    const taskManager = {
      getOrCreateCurrentOrchestrator: vi.fn(() => ({ setWorkingDirectory: orchestratorSetWd })),
      setSessionContext: vi.fn(),
      setWorkingDirectory,
      startTask,
      getSessionState: vi.fn(() => ({ status: 'idle' })),
    };

    await launchApprovedNeoWorkCard({
      workCardId: card.id,
      taskManager,
      service,
      now: () => 100,
      target: { conversationId: 'conv_B', turnId: 'turn_round2' },
    });

    // 执行落在目标会话，锚点用轮 turnId
    expect(startTask).toHaveBeenCalledWith(
      'conv_B',
      expect.any(String),
      undefined,
      expect.any(Object),
      expect.objectContaining({ neoTag: expect.objectContaining({ sourceTurnId: 'turn_round2' }) }),
      'turn_round2',
    );
    expect(taskManager.setSessionContext).toHaveBeenCalledWith('conv_B', targetHistory);
    // D2 护栏：跨会话续接不得持久改写目标会话工作目录
    expect(setWorkingDirectory).not.toHaveBeenCalled();
    expect(orchestratorSetWd).not.toHaveBeenCalled();
    // 每条 delta 都带轮会话归属
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      expect(delta.conversationId).toBe('conv_B');
    }
  });

  it('defaults to source conversation when no target given (existing behaviour + conversationId backfill)', async () => {
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        resultReviews: [],
        memoryCandidates: [],
        deltas,
      })),
      setStatus: vi.fn(() => card),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = { ...input, id: `delta_${deltas.length + 1}`, createdAt: deltas.length + 1 } as NeoWorkCardDelta;
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;
    const startTask = vi.fn<NeoTagTaskManager['startTask']>(async () => {});
    const taskManager = { startTask, getSessionState: vi.fn(() => ({ status: 'idle' })) };

    await launchApprovedNeoWorkCard({ workCardId: card.id, taskManager, service, now: () => 100 });

    expect(startTask.mock.calls[0][0]).toBe('conv_1');
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      expect(delta.conversationId).toBe('conv_1');
    }
  });

  it('creates, auto-approves, and launches a work card in one direct-run step (@neo 直接开干)', async () => {
    sessionMessages.splice(0, sessionMessages.length,
      { id: 'msg_source', role: 'user', content: '@neo 直接开干', timestamp: 1 },
    );
    const card = workCard({ status: 'draft', approvedRevisionId: null });
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const statuses: string[] = [];
    const reasons: string[] = [];
    const approveCalls: Array<{ workCardId: string; revisionId?: string; reviewerUserId: string }> = [];
    const service = {
      createDraft: vi.fn(() => ({ workCard: card, revision: rev })),
      approveRevision: vi.fn((input: { workCardId: string; revisionId?: string; reviewerUserId: string }) => {
        approveCalls.push(input);
        card.status = 'approved';
        card.approvedRevisionId = rev.id;
        return { id: 'appr_1' };
      }),
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        deltas,
        resultReviews: [],
        memoryCandidates: [],
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        statuses.push(status);
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;

    const draft: CreateNeoWorkCardDraftInput = {
      projectId: 'proj_1',
      sourceConversationId: 'conv_1',
      sourceTurnId: 'msg_source',
      requesterUserId: 'user_1',
      title: '直接开干',
      revision: { intent: 'implement', taskSummary: '直接开干' },
    };

    const started = createAndRunNeoWorkCard({
      draft,
      service,
      taskManager: {
        startTask: vi.fn(async () => {
          // 终态契约：完成需要非空最终回复的正向证据（本轮 user id = sourceTurnId）。
          sessionMessages.push({ id: 'assistant_direct', role: 'assistant', content: '直接开干完成。', timestamp: 2 });
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
      now: () => 100,
      onWorkCardUpdated: (_workCardId, reason) => reasons.push(reason),
    });

    // 建卡 + 批准同步完成，卡立即可返回（IPC 无需等待后台运行）
    expect(service.createDraft).toHaveBeenCalledTimes(1);
    expect(approveCalls[0]).toMatchObject({ workCardId: card.id, reviewerUserId: 'user_1' });
    expect(started.workCard.id).toBe(card.id);
    expect(reasons).toContain('draft_created');
    expect(reasons).toContain('revision_approved');

    // 无审批门：后台运行落地
    const launched = await started.run;
    expect(statuses).toEqual(['queued', 'working', 'in_result_review']);
    expect(launched.runId).toBeTruthy();
  });

  it('moves provider launch failures into failed work card delta instead of leaving working', async () => {
    const card = workCard();
    const rev = revision({ mode: 'fixed_model', provider: 'openai', model: 'bad-model' });
    const deltas: NeoWorkCardDelta[] = [];
    const statuses: string[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        deltas,
        resultReviews: [],
        memoryCandidates: [],
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        statuses.push(status);
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;
    const liveUpdates: string[] = [];

    await launchApprovedNeoWorkCard({
      workCardId: card.id,
      service,
      taskManager: {
        startTask: vi.fn(async () => {
          throw new Error('401 Unauthorized: invalid API key');
        }),
        getSessionState: vi.fn(() => ({ status: 'error', error: '401 Unauthorized: invalid API key' })),
      },
      now: () => 100,
      onWorkCardUpdated: (_workCardId, reason) => liveUpdates.push(reason),
    });

    expect(statuses).toEqual(['queued', 'working', 'failed']);
    expect(liveUpdates).toEqual(['runtime_queued', 'runtime_working', 'runtime_failed']);
    expect(deltas.at(-1)?.risks).toContain('401 Unauthorized: invalid API key');
    expect(deltas.at(-1)?.openQuestions.join('\n')).toContain('provider credentials');
    expect(deltas.at(-1)?.decisions.join('\n')).toContain('Context audit: pack=');
  });

  it('moves async agent loop errors into failed work card delta after startTask returns', async () => {
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const statuses: string[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        deltas,
        resultReviews: [],
        memoryCandidates: [],
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        statuses.push(status);
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;

    await launchApprovedNeoWorkCard({
      workCardId: card.id,
      service,
      taskManager: {
        startTask: vi.fn(async () => undefined),
        getSessionState: vi.fn(() => ({ status: 'error', error: 'Provider returned 401' })),
      },
      now: () => 100,
    });

    expect(statuses).toEqual(['queued', 'working', 'failed']);
    // 失败原因现在带出路（N-CHAT-EMPTY-FINAL-NO-EXIT：失败态带出路不带解释）
    expect(deltas.at(-1)?.risks[0]).toContain('Provider returned 401');
    expect(deltas.at(-1)?.risks[0]).toContain('接着做');
    expect(deltas.at(-1)?.nextStep).toContain('runtime/provider error');
  });

  it('reads TaskManager state through the instance so provider errors are not masked', async () => {
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const statuses: string[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        deltas,
        resultReviews: [],
        memoryCandidates: [],
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        statuses.push(status);
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;
    const taskManager = {
      states: new Map([['conv_1', { status: 'error', error: 'Invalid API Key' }]]),
      startTask: vi.fn(async () => undefined),
      getSessionState(sessionId: string) {
        return this.states.get(sessionId) ?? { status: 'idle' };
      },
    };

    await launchApprovedNeoWorkCard({
      workCardId: card.id,
      service,
      taskManager,
      now: () => 100,
    });

    expect(statuses).toEqual(['queued', 'working', 'failed']);
    expect(deltas.at(-1)?.risks[0]).toContain('Invalid API Key');
    expect(deltas.at(-1)?.risks[0]).toContain('换一个模型');
    expect(deltas.at(-1)?.openQuestions.join('\n')).toContain('provider credentials');
  });

  it('does not include runtime changes outside approved write scope', async () => {
    const workspace = await createTempWorkspace();
    sessionWorkingDirectory = workspace;
    await writeWorkspaceFile(workspace, 'src/host/services/project/neoTagRuntimeService.ts', 'before');
    await writeWorkspaceFile(workspace, 'docs/neo-notes.md', 'before');
    await writeWorkspaceFile(workspace, 'src/renderer/components/features/settings/tabs/ModelSettings.tsx', 'before');
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        resultReviews: [],
        memoryCandidates: [],
        deltas,
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;

    await launchApprovedNeoWorkCard({
      workCardId: card.id,
      service,
      taskManager: {
        startTask: vi.fn(async () => {
          await writeWorkspaceFile(workspace, 'src/host/services/project/neoTagRuntimeService.ts', 'after');
          await writeWorkspaceFile(workspace, 'docs/neo-notes.md', 'after');
          await writeWorkspaceFile(workspace, 'src/renderer/components/features/settings/tabs/ModelSettings.tsx', 'after');
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 按范围改写', timestamp: 2 },
            { id: 'assistant_scope', role: 'assistant', content: '已按范围改写。', timestamp: 3 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
      now: () => 100,
    });

    expect(deltas.at(-1)?.changedFiles).toEqual(['src/host/services/project/neoTagRuntimeService.ts']);
  });

  // ── 终态契约（N-CHAT-EMPTY-FINAL-NO-EXIT）───────────────────────────────
  // 完成必须有正向证据（非空最终回复）；失败按旁听到的终态错误分类给人话 + 出路。

  interface TerminalTestHarness {
    service: NeoWorkCardService;
    deltas: NeoWorkCardDelta[];
    statuses: string[];
    blockedReasons: Array<string | undefined>;
  }

  function terminalHarness(): TerminalTestHarness {
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const statuses: string[] = [];
    const blockedReasons: Array<string | undefined> = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        deltas,
        resultReviews: [],
        memoryCandidates: [],
      })),
      setStatus: vi.fn((_id: string, status: NeoWorkCard['status'], _now: number, reason?: string | null) => {
        statuses.push(status);
        blockedReasons.push(reason ?? undefined);
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;
    return { service, deltas, statuses, blockedReasons };
  }

  it('终态契约：provider 401（MODEL_AUTH 终态错误事件）进失败态，带人话原因与出路，不出现账本术语', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => undefined),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
        observeAgentEvents: (observer) => {
          // runFinalizer 的终态错误事件：RUN_FAILED + 鉴权标记（401 真实形状）
          observer('conv_1', {
            type: 'error',
            data: {
              message: '模型鉴权失败：API Key 无效、已过期或没有权限。',
              code: 'RUN_FAILED',
              details: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
              failure: { code: 'MODEL_AUTH', provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
            },
          } as never);
          return () => {};
        },
      },
    });

    expect(h.statuses).toEqual(['queued', 'working', 'failed']);
    const reason = h.blockedReasons.at(-1) ?? '';
    expect(reason).toContain('API Key');
    expect(reason).toContain('设置');
    expect(reason).toContain('接着做');
    // 验收 4：用户面不出现账本术语
    for (const term of ['RUN_FAILED', 'MODEL_AUTH', 'in_result_review', 'completed_unverified', 'turn_outcome']) {
      expect(reason).not.toContain(term);
    }
    expect(h.deltas.at(-1)?.risks[0]).toBe(reason);
  });

  it('终态契约：额度不足（MODEL_QUOTA）与模型不可用（MODEL_UNAVAILABLE）各自给「换一个模型」出路', async () => {
    for (const [failureCode, keyword] of [
      ['MODEL_QUOTA', '额度不足'],
      ['MODEL_UNAVAILABLE', '模型不可用'],
    ] as const) {
      const h = terminalHarness();
      await launchApprovedNeoWorkCard({
        workCardId: 'nwc_1',
        service: h.service,
        now: () => 100,
        taskManager: {
          startTask: vi.fn(async () => undefined),
          getSessionState: vi.fn(() => ({ status: 'idle' })),
          observeAgentEvents: (observer) => {
            observer('conv_1', {
              type: 'error',
              data: { message: 'provider failed', code: 'RUN_FAILED', failure: { code: failureCode } },
            } as never);
            return () => {};
          },
        },
      });
      expect(h.statuses.at(-1)).toBe('failed');
      const reason = h.blockedReasons.at(-1) ?? '';
      expect(reason).toContain(keyword);
      expect(reason).toContain('换一个模型');
    }
  });

  it('终态契约：空最终回复不许记为完成——没有任何终态错误也要归失败并给重试入口', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => undefined),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    // 排除法兜底已被废除：state=idle + 没有错误事件 ≠ 完成
    expect(h.statuses).toEqual(['queued', 'working', 'failed']);
    const reason = h.blockedReasons.at(-1) ?? '';
    expect(reason).toContain('没有生成最终回复');
    expect(reason).toContain('接着做');
  });

  it('终态契约：同会话 auxiliary 后台任务（带 taskId）的失败/取消不污染工作卡主 run（ai-review Important 二轮）', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
            { id: 'assistant_ok', role: 'assistant', content: '做完了。', timestamp: 2 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
        observeAgentEvents: (observer) => {
          // 主 run 完成后，同会话 auxiliary 后台任务失败（taskId 存在）
          observer('conv_1', {
            type: 'error',
            data: { message: 'background task 401', code: 'RUN_FAILED' },
          } as never, 'agent-engine:background-1');
          return () => {};
        },
      },
    });

    // 主 run 有正向证据 + 污染事件带 taskId → 不受影响，照常完成
    expect(h.statuses).toEqual(['queued', 'working', 'in_result_review']);
  });

  it('终态契约：后到的裸 error 不覆盖先到的结构化失败（额度出路不丢，ai-review Important）', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => undefined),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
        observeAgentEvents: (observer) => {
          // runFinalizer 先发带标记的（真实顺序），orchestrator catch 后发裸的
          observer('conv_1', {
            type: 'error',
            data: { message: '余额不足', code: 'RUN_FAILED', failure: { code: 'MODEL_QUOTA' } },
          } as never);
          observer('conv_1', {
            type: 'error',
            data: { message: 'Provider request failed', code: 'RUN_FAILED' },
          } as never);
          return () => {};
        },
      },
    });

    expect(h.statuses.at(-1)).toBe('failed');
    expect(h.blockedReasons.at(-1)).toContain('额度不足');
    expect(h.blockedReasons.at(-1)).not.toContain('Provider request failed');
  });

  it('终态契约：run 被取消 → 失败态「运行被手动中止」+ 继续入口（不记完成）', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => undefined),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
        observeAgentEvents: (observer) => {
          observer('conv_1', { type: 'agent_cancelled', data: null } as never);
          return () => {};
        },
      },
    });

    expect(h.statuses.at(-1)).toBe('failed');
    expect(h.blockedReasons.at(-1)).toContain('手动中止');
    expect(h.blockedReasons.at(-1)).toContain('接着做');
  });

  it('终态契约：有非空最终回复的正向证据时才记完成（in_result_review），正常完成不回退', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
            { id: 'assistant_ok', role: 'assistant', content: '做完了，产物如下。', timestamp: 2 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    expect(h.statuses).toEqual(['queued', 'working', 'in_result_review']);
  });

  it('终态契约：回复落库后用户追发新消息，仍按锚点确认本轮有正向证据', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
            { id: 'assistant_ok', role: 'assistant', content: '做完了，产物如下。', timestamp: 2 },
            { id: 'msg_followup', role: 'user', content: '再补一句说明', timestamp: 3 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    expect(h.statuses).toEqual(['queued', 'working', 'in_result_review']);
  });

  it('终态契约：skill 注入的 user 消息不截断本轮最终回复', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
            { id: 'assistant_tool', role: 'assistant', content: '', timestamp: 2 },
            { id: 'skill_status', role: 'user', content: 'Loading skill', timestamp: 3, source: 'skill' },
            {
              id: 'skill_instructions',
              role: 'user',
              content: 'Skill instructions',
              timestamp: 4,
              isMeta: true,
              source: 'skill',
            },
            { id: 'assistant_ok', role: 'assistant', content: '技能执行完成，结果如下。', timestamp: 5 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    expect(h.statuses).toEqual(['queued', 'working', 'in_result_review']);
  });

  it('终态契约：只有工具输出没有正文（几百行文件清单收尾）不算正向证据', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            {
              id: 'assistant_tools_only',
              role: 'assistant',
              content: '',
              timestamp: 2,
              toolCalls: [{ id: 'tc_1', name: 'list_files', arguments: {} } as never],
            },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    expect(h.statuses.at(-1)).toBe('failed');
    expect(h.blockedReasons.at(-1)).toContain('没有生成最终回复');
  });

  it('终态契约：run 暂停等待用户输入 → waiting_for_user（受阻态，不算完成也不算失败）', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: (() => {
        // context 检查阶段必须空闲（paused 会被判「会话忙」拒绝启动），
        // run 结束后进入 paused（run 中途等审批、startTask 挂起后 resume 收尾的形态）
        let state: { status: string; error?: string } = { status: 'idle' };
        return {
          startTask: vi.fn(async () => {
            state = { status: 'paused' };
          }),
          getSessionState: vi.fn(() => state),
        };
      })(),
    });

    expect(h.statuses).toEqual(['queued', 'working', 'waiting_for_user']);
    expect(h.deltas.at(-1)?.nextStep).toContain('pending runtime request');
  });

  it('终态契约：并发满排队（startTask 入队即返回）→ 等这一轮真正执行完再判终态，成功不误判失败（ai-review Important 三轮）', async () => {
    vi.useFakeTimers();
    try {
      const h = terminalHarness();
      // workingDirectory 置空：跳过 artifact snapshot 的真实 fs IO（fake timers 下
      // threadpool 宏任务不推进，launch 链会被卡在 startTask 之前）
      sessionWorkingDirectory = undefined;
      // 会话状态机模拟 TaskManager 并发满的排队形状：入队（startTask 即返回）→
      // 排队若干拍 → 槽位空出转 running（run 执行、产出回复）→ idle。
      let state: { status: string; error?: string } = { status: 'idle' };
      const observed: string[] = [];
      const startTask = vi.fn(async () => {
        // 并发满：只入队就返回，不等执行；user 锚点此刻已落库，回复还没有。
        state = { status: 'queued' };
        sessionMessages.push(
          { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
        );
      });
      const launched = launchApprovedNeoWorkCard({
        workCardId: 'nwc_1',
        service: h.service,
        now: () => 100,
        taskManager: {
          startTask,
          getSessionState: vi.fn(() => {
            observed.push(state.status);
            return state;
          }),
        },
      });
      // launch 链推进到入队（fake timers 下微任务链要靠 timer 推进带出来）
      let waited = 0;
      while (state.status !== 'queued' && waited < 5_000) {
        await vi.advanceTimersByTimeAsync(50);
        waited += 50;
      }
      // 排队的几拍过去：工作卡不许在排队期间被判终态
      await vi.advanceTimersByTimeAsync(1_000);
      expect(state.status).toBe('queued');
      expect(startTask).toHaveBeenCalledTimes(1);
      expect(h.statuses).toEqual(['queued', 'working']);
      // 槽位空出：run 开始执行并产出非空回复
      state = { status: 'running' };
      sessionMessages.push(
        { id: 'assistant_ok', role: 'assistant', content: '做完了，产物如下。', timestamp: 2 },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      state = { status: 'idle' };
      // 推进 waitForRuntimeState 的收尾轮询（fake timer 不会自己到点）
      await vi.advanceTimersByTimeAsync(1_000);
      await launched;

      expect(h.statuses).toEqual(['queued', 'working', 'in_result_review']);
      // 排队期间确实观察到 queued/running（终态判定等的是真实执行，不是跳过）
      expect(observed).toContain('queued');
      expect(observed).toContain('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态契约：排队等待超上限 → failed 带人话原因与「接着做」重试出路（超时=真失败，不排队=成功糊弄）', async () => {
    vi.useFakeTimers();
    try {
      const h = terminalHarness();
      sessionWorkingDirectory = undefined;
      // 状态机：过前置空闲检查（idle）→ startTask 入队 → 永远 queued（槽位一直不空）
      let state: { status: string; error?: string } = { status: 'idle' };
      const launched = launchApprovedNeoWorkCard({
        workCardId: 'nwc_1',
        service: h.service,
        now: () => 100,
        taskManager: {
          startTask: vi.fn(async () => {
            state = { status: 'queued' };
          }),
          getSessionState: vi.fn(() => state),
        },
      });
      await vi.advanceTimersByTimeAsync(
        TASK_QUEUE_TIMEOUTS.QUEUE_TIMEOUT_MS + TASK_QUEUE_TIMEOUTS.QUEUE_DRAIN_GRACE_MS + 10_000,
      );
      await launched;

      expect(h.statuses.at(-1)).toBe('failed');
      const reason = h.blockedReasons.at(-1) ?? '';
      expect(reason).toContain('排队超时');
      expect(reason).toContain('接着做');
      expect(h.deltas.at(-1)?.nextStep).toContain('retry');
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态契约：TaskManager 自己的队列超时先落 error(Queue timeout) → 同样按排队超时给人话失败', async () => {
    vi.useFakeTimers();
    try {
      const h = terminalHarness();
      const launched = launchApprovedNeoWorkCard({
        workCardId: 'nwc_1',
        service: h.service,
        now: () => 100,
        taskManager: {
          startTask: vi.fn(async () => undefined),
          getSessionState: vi.fn(() => ({
            status: 'error',
            error: 'Queue timeout',
          })),
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await launched;

      expect(h.statuses.at(-1)).toBe('failed');
      const reason = h.blockedReasons.at(-1) ?? '';
      expect(reason).toContain('排队超时');
      expect(reason).toContain('接着做');
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态契约：运行中转向（steer）插入 user 后的最终回复仍算本轮正向证据（ai-review 第 5 轮 Important）', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
            // 转向前只有工具调用、无正文
            { id: 'assistant_tool', role: 'assistant', content: '', timestamp: 2 },
            // 运行中用户补话：injectSteerMessage 以 role:'user' 推进同一轮 history
            {
              id: 'msg_steer',
              role: 'user',
              content: '顺便把标题也改了',
              timestamp: 3,
              metadata: { runtimeSteer: true },
            },
            { id: 'assistant_ok', role: 'assistant', content: '做完了，标题也改了。', timestamp: 4 },
            { id: 'msg_followup', role: 'user', content: '再补一句说明', timestamp: 5 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    // 截到「下一条 user」为止的窗口版会漏掉转向后的回复 → failed；应为 in_result_review
    expect(h.statuses).toEqual(['queued', 'working', 'in_result_review']);
  });

  it('终态契约：转向前的进度文本不能冒充转向后的最终回复', async () => {
    const h = terminalHarness();
    await launchApprovedNeoWorkCard({
      workCardId: 'nwc_1',
      service: h.service,
      now: () => 100,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push(
            { id: 'msg_source', role: 'user', content: '@neo 干活', timestamp: 1 },
            {
              id: 'assistant_progress',
              role: 'assistant',
              content: '开始处理了。',
              timestamp: 2,
              toolCalls: [{ id: 'tc_progress', name: 'list_files', arguments: {} } as never],
            },
            {
              id: 'msg_steer',
              role: 'user',
              content: '改成另一种方案',
              timestamp: 3,
              metadata: { runtimeSteer: true },
            },
            { id: 'assistant_empty', role: 'assistant', content: '', timestamp: 4 },
          );
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
    });

    expect(h.statuses.at(-1)).toBe('failed');
    expect(h.blockedReasons.at(-1)).toContain('没有生成最终回复');
  });

  it('returns an empty changedFiles result when no approved files actually change', async () => {
    const workspace = await createTempWorkspace();
    sessionWorkingDirectory = workspace;
    await writeWorkspaceFile(workspace, 'src/host/services/project/neoTagRuntimeService.ts', 'same');
    const card = workCard();
    const rev = revision();
    const deltas: NeoWorkCardDelta[] = [];
    const service = {
      get: vi.fn((): NeoWorkCardDetail => ({
        workCard: card,
        currentRevision: rev,
        approvedRevision: rev,
        revisions: [rev],
        approvals: [],
        resultReviews: [],
        memoryCandidates: [],
        deltas,
      })),
      setStatus: vi.fn((_workCardId: string, status: NeoWorkCard['status']) => {
        card.status = status;
        return card;
      }),
      appendDelta: vi.fn((input: Partial<NeoWorkCardDelta>) => {
        const delta = {
          id: `delta_${deltas.length + 1}`,
          workCardId: card.id,
          runId: input.runId || 'run_1',
          completed: input.completed || [],
          changedFiles: input.changedFiles || [],
          decisions: input.decisions || [],
          openQuestions: input.openQuestions || [],
          risks: input.risks || [],
          memoryCandidates: input.memoryCandidates || [],
          nextStep: input.nextStep,
          createdAt: deltas.length + 1,
        };
        deltas.push(delta);
        return delta;
      }),
    } as unknown as NeoWorkCardService;

    await launchApprovedNeoWorkCard({
      workCardId: card.id,
      service,
      taskManager: {
        startTask: vi.fn(async () => {
          sessionMessages.push({ id: 'assistant_nochg', role: 'assistant', content: '没有需要改的文件。', timestamp: 3 });
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
      now: () => 100,
    });

    expect(deltas.at(-1)?.changedFiles).toEqual([]);
  });
});
