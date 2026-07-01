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
import { launchApprovedNeoWorkCard } from '../../../src/host/services/project/neoTagRuntimeService';
import type { NeoWorkCardService } from '../../../src/host/services/project/neoWorkCardService';

const sessionMessages: Message[] = [];
let sessionWorkingDirectory = '/repo/project';
const tempDirs: string[] = [];

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: vi.fn(async () => ({
      id: 'conv_1',
      workingDirectory: sessionWorkingDirectory,
      messages: sessionMessages,
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
      })),
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
      setWorkingDirectory: vi.fn(),
      startTask: vi.fn(async () => {
        await writeWorkspaceFile(workspace, 'src/host/services/project/neoTagRuntimeService.ts', 'after');
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
      expect.any(String),
    );
    expect(deltas[0].completed[0]).toContain('Queued approved revision');
    expect(deltas[0].decisions.join('\n')).toContain('Context audit: pack=');
    expect(deltas.at(-1)?.changedFiles).toEqual(['src/host/services/project/neoTagRuntimeService.ts']);
    expect(deltas.at(-1)?.decisions.join('\n')).toContain('sources=messages+artifacts+files+memory');
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
    expect(deltas.at(-1)?.risks).toEqual(['Provider returned 401']);
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
    expect(deltas.at(-1)?.risks).toEqual(['Invalid API Key']);
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
        }),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
      now: () => 100,
    });

    expect(deltas.at(-1)?.changedFiles).toEqual(['src/host/services/project/neoTagRuntimeService.ts']);
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
        startTask: vi.fn(async () => undefined),
        getSessionState: vi.fn(() => ({ status: 'idle' })),
      },
      now: () => 100,
    });

    expect(deltas.at(-1)?.changedFiles).toEqual([]);
  });
});
