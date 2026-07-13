import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import type { Message } from '../../../src/shared/contract';
import { CompressionState } from '../../../src/host/context/compressionState';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from '../../../src/host/agent/runtime/contextAssembly/shared';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  getPromptForTask: vi.fn(() => 'system prompt'),
  needsGenerativeUI: vi.fn(() => false),
  GENERATIVE_UI_PROMPT: 'generative ui prompt',
  QUESTION_FORM_PROMPT: 'question form prompt',
  ARTIFACT_TASK_BRIEF_PROMPT: 'ARTIFACT_BRIEF_MARKER',
  needsArtifactTaskBrief: vi.fn((message: string) => /生成|create|build|make|write|game/i.test(message)),
}));

vi.mock('../../../src/host/prompts/projectSystemPrompt', () => ({
  loadProjectSystemPrompt: vi.fn(() => ({
    custom: null,
    append: null,
    fullReplace: null,
    sources: { customPath: null, appendPath: null, fullReplacePath: null },
  })),
}));

vi.mock('../../../src/host/prompts/remoteFragments', () => ({
  getTrustedRemotePromptFragmentsRevision: vi.fn(() => 0),
}));

vi.mock('../../../src/host/prompts/providerVariants', () => ({
  applyProviderVariant: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../../src/host/agent/messageHandling/contextBuilder', () => ({
  buildGitStatusBlock: vi.fn(() => ''),
  injectWorkingDirectoryContext: vi.fn((prompt: string) => prompt),
  buildEnhancedSystemPrompt: vi.fn(async (prompt: string) => prompt),
  buildRuntimeModeBlock: vi.fn(() => ''),
}));

vi.mock('../../../src/host/lightMemory/sessionMetadata', () => ({
  buildSessionMetadataBlock: vi.fn(async () => ''),
}));

vi.mock('../../../src/host/lightMemory/recentConversations', () => ({
  buildRecentConversationsBlock: vi.fn(async () => ''),
}));

vi.mock('../../../src/host/lightMemory/indexLoader', () => ({
  loadMemoryIndex: vi.fn(async () => null),
}));

vi.mock('../../../src/host/lightMemory/failureJournal', () => ({
  buildFailureJournalBlock: vi.fn(async () => null),
}));

vi.mock('../../../src/host/lightMemory/skillLoader', () => ({
  loadRelevantSkills: vi.fn(async () => []),
  buildSkillInjectionBlock: vi.fn(() => null),
}));

vi.mock('../../../src/host/context/repoMap', () => ({
  getRepoMap: vi.fn(async () => ({
    text: '',
    fileCount: 0,
    symbolCount: 0,
    estimatedTokens: 0,
  })),
}));

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getDeferredToolsSummary: vi.fn(() => ''),
}));

vi.mock('../../../src/host/agent/activeAgentContext', () => ({
  buildActiveAgentContext: vi.fn(() => ''),
  drainCompletionNotifications: vi.fn(() => []),
  resolveActiveAgentScopeFilter: vi.fn((sessionId: string) => ({ sessionId })),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    addLog: vi.fn(),
    tool: vi.fn(),
    browser: vi.fn(),
  },
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({
    store: vi.fn(),
  }),
}));

vi.mock('../../../src/host/context/contextInterventionState', () => ({
  getContextInterventionState: () => ({
    getEffectiveSnapshot: vi.fn(() => ({ excluded: [] })),
  }),
}));

vi.mock('../../../src/host/context/contextInterventionHelpers', () => ({
  applyInterventionsToMessages: vi.fn((entries: ContextTranscriptEntry[]) => entries),
}));

vi.mock('../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ({
    upsertCompressionEvents: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/checkpointWriterService', () => ({
  getCheckpointWriterService: () => ({
    maybeTriggerPeriodic: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/runtime/runtimeStatePersistence', () => ({
  persistRuntimeState: vi.fn(),
}));

vi.mock('../../../src/host/plugins/pluginRegistry', () => ({
  getPluginRegistry: () => ({
    getPlugins: vi.fn(() => []),
  }),
}));

vi.mock('../../../src/host/agent/runtime/contextAssembly/archiveHydration', () => ({
  applyArchiveHydration: vi.fn((entries: ContextTranscriptEntry[]) => entries),
}));

import { buildModelMessages } from '../../../src/host/agent/runtime/contextAssembly/messageBuild';

function buildMessage(content: string): Message {
  return {
    id: `user-${Math.random()}`,
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function toTranscriptEntry(message: Message, index: number): ContextTranscriptEntry {
  return {
    id: message.id,
    originMessageId: message.id,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    timestamp: message.timestamp,
    turnIndex: index,
    attachments: message.attachments,
    toolCalls: message.toolCalls,
  };
}

function makeCtx(userMessage: string): ContextAssemblyCtx {
  const messages = [buildMessage(userMessage)];
  return {
    runtime: {
      sessionId: `session-${Math.random()}`,
      agentId: undefined,
      workingDirectory: '/tmp/code-agent',
      isDefaultWorkingDirectory: false,
      turn: TurnState.forTest({ isSimpleTaskMode: false }),
      enableToolDeferredLoading: false,
      memoryMode: 'off',
      modelConfig: {
        provider: 'mock',
        model: 'test-model',
        apiKey: 'mock-key',
        temperature: 0,
        maxTokens: 4096,
      },
      messages,
      droppedPromptBlocks: [],
      pendingRuntimeDiagnostics: [],
      compressionState: new CompressionState(),
      compressionPipeline: {
        evaluate: vi.fn(async (entries: ContextTranscriptEntry[], state: CompressionState) => ({
          apiView: entries,
          totalTokens: 0,
          layersTriggered: [],
          compressionState: state,
        })),
      },
      messageHistoryCompressor: {
        shouldProactivelyCompress: vi.fn(() => false),
      },
      turnTrace: {
        record: vi.fn(),
      },
    },
    taskProgress: {},
    recordTokenUsage: vi.fn(),
    inference: vi.fn(),
    buildModelMessages: vi.fn(),
    buildContextTranscriptEntries: vi.fn((sourceMessages: Message[]) =>
      sourceMessages.map((message, index) => toTranscriptEntry(message, index))),
    mapInterventionsToTranscriptEntries: vi.fn(() => ({ excluded: [] })),
    summarizeCollapsedContext: vi.fn(async () => 'summary'),
    loadResearchSkillPrompt: vi.fn(() => null),
    injectSystemMessage: vi.fn(),
    flushHookMessageBuffer: vi.fn(),
    pushPersistentSystemContext: vi.fn(),
    getBudgetedPersistentSystemContext: vi.fn(() => []),
    trimPersistentSystemContext: vi.fn(),
    truncatePersistentSystemContext: vi.fn((content: string) => content),
    inferBufferedSystemMessageCategory: vi.fn(() => undefined),
    generateId: vi.fn(() => 'id'),
    recordContextEventsForMessage: vi.fn(),
    buildContextEventsForMessage: vi.fn(() => []),
    checkAndAutoCompress: vi.fn(),
    shouldThink: vi.fn(() => false),
    generateThinkingPrompt: vi.fn(() => ''),
    formatArtifactRepairToolResultContent: vi.fn((_result: unknown, originalContent: string) => originalContent),
  } as unknown as ContextAssemblyCtx;
}

async function buildSystemPrompt(userMessage: string): Promise<string> {
  const modelMessages = await buildModelMessages(makeCtx(userMessage));
  expect(modelMessages[0].role).toBe('system');
  return modelMessages[0].content as string;
}

describe('messageBuild game skill knowledge injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects platformer generation knowledge for platformer-flavored game requests', async () => {
    const prompt = await buildSystemPrompt('生成一个类似超级玛丽的 platformer HTML 游戏，保存到 /tmp/game.html');

    expect(prompt).toContain('## Game Artifact Contract');
    expect(prompt).toContain('This section is build-time inlined into game prompt assembly');
    expect(prompt).toContain('Translate genre/reference into mechanics');
    expect(prompt).toContain("nearby authored smoke scenarios like `reset('stomp')`");
    expect(prompt).not.toContain('Player auto-moves along `forwardAxis`');
  });

  it('injects runner generation knowledge for runner-flavored game requests', async () => {
    const prompt = await buildSystemPrompt('Build a RUNNER game as a single HTML file');

    expect(prompt).toContain('## Game Artifact Contract');
    expect(prompt).toContain('Player auto-moves along `forwardAxis`');
    expect(prompt).toContain('legitimate empty / "none" input');
    expect(prompt).not.toContain('This section is build-time inlined into game prompt assembly');
  });

  it('does not inject subtype skill knowledge for generic game requests without a subtype match', async () => {
    const prompt = await buildSystemPrompt('生成一个 tower defense game，保存到 /tmp/game.html');

    expect(prompt).toContain('## Game Artifact Contract');
    expect(prompt).not.toContain('Player auto-moves along `forwardAxis`');
    expect(prompt).not.toContain('This section is build-time inlined into game prompt assembly');
    expect(prompt).not.toContain('legitimate empty / "none" input');
  });
});
