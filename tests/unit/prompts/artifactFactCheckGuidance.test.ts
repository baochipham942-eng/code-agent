import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { CompressionState } from '../../../src/host/context/compressionState';

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/logCollector', () => ({
  logCollector: { agent: vi.fn(), addLog: vi.fn(), tool: vi.fn(), browser: vi.fn() },
}));

vi.mock('../../../src/host/prompts/builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/prompts/builder')>();
  return {
    ...actual,
    getPromptForTask: vi.fn(() => 'system prompt'),
  };
});

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

vi.mock('../../../src/host/lightMemory/indexLoader', async (importOriginal) => ({
  listMemoryIndexTargets: (await importOriginal<typeof import('../../../src/host/lightMemory/indexLoader')>())
    .listMemoryIndexTargets,
  loadMemoryIndex: vi.fn(async () => null),
}));

vi.mock('../../../src/host/lightMemory/failureJournal', () => ({
  buildFailureJournalBlock: vi.fn(async () => null),
}));

vi.mock('../../../src/host/lightMemory/skillLoader', () => ({
  loadRelevantSkills: vi.fn(async () => ({
    fullSkills: [],
    omittedSkillSummaries: [],
    unlistedSkillCount: 0,
  })),
  buildSkillInjectionBlock: vi.fn(() => null),
}));

vi.mock('../../../src/host/context/repoMap', () => ({
  getRepoMap: vi.fn(async () => ({ text: '', fileCount: 0, symbolCount: 0, estimatedTokens: 0 })),
}));

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getDeferredToolsSummary: vi.fn(() => ''),
}));

vi.mock('../../../src/host/agent/activeAgentContext', () => ({
  buildActiveAgentContext: vi.fn(() => ''),
  drainCompletionNotifications: vi.fn(() => []),
  resolveActiveAgentScopeFilter: vi.fn((sessionId: string) => ({ sessionId })),
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({ store: vi.fn() }),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: vi.fn(() => 'mock-key') }),
  getAuthService: () => ({}),
  getLangfuseService: () => ({
    startTrace: vi.fn(),
    logEvent: vi.fn(),
    endTrace: vi.fn(),
    startSpan: vi.fn(() => 'span-1'),
    endSpan: vi.fn(),
    startGenerationInSpan: vi.fn(),
  }),
  getBudgetService: () => ({
    checkBudget: vi.fn(() => ({ exceeded: false })),
    recordUsage: vi.fn(),
  }),
  BudgetAlertLevel: { NONE: 'none', WARNING: 'warning', CRITICAL: 'critical' },
  getSessionManager: () => ({
    addMessage: vi.fn(),
    addMessageToSession: vi.fn(),
    replaceMessages: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/checkpointWriterService', () => ({
  getCheckpointWriterService: () => ({ maybeTriggerPeriodic: vi.fn() }),
}));

vi.mock('../../../src/host/agent/runtime/runtimeStatePersistence', () => ({
  persistRuntimeState: vi.fn(),
}));

vi.mock('../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ({
    upsertEvents: vi.fn(),
    upsertCompressionEvents: vi.fn(),
  }),
}));

vi.mock('../../../src/host/plugins/pluginRegistry', () => ({
  getPluginRegistry: () => ({ getPlugins: vi.fn(() => []) }),
}));

vi.mock('../../../src/host/agent/runtime/contextAssembly/inference', () => ({
  inference: vi.fn(),
}));

vi.mock('../../../src/host/agent/runtime/contextAssembly/modeInjection', () => ({
  loadResearchSkillPrompt: vi.fn(() => null),
  injectResearchModePrompt: vi.fn(),
  buildPlanContextMessage: vi.fn(async () => null),
  shouldThink: vi.fn(() => false),
  generateThinkingPrompt: vi.fn(() => ''),
  maybeInjectThinking: vi.fn(),
}));

import { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import {
  ARTIFACT_TASK_BRIEF_PROMPT,
  GAME_ARTIFACT_CONTRACT_PROMPT,
  needsArtifactTaskBrief,
  needsGameArtifactContract,
} from '../../../src/host/prompts/builder';

const FACT_CHECK_HEADING = 'Fact-check rules:';
const FACT_CHECK_BUDGET_CHARS = 900;
const FORBIDDEN_MANDATORY_SEARCH = [
  /must search first/i,
  /before any write you must search/i,
  /you must search/i,
  /must search before/i,
  /required to search/i,
];

function factCheckSection(prompt: string): string {
  const start = prompt.indexOf(FACT_CHECK_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = prompt.slice(start);
  const nextSection = rest.search(/\n\n[A-Z]/);
  return (nextSection === -1 ? rest : rest.slice(0, nextSection)).trim();
}

function buildMessage(id: string, content: string): Message {
  return { id, role: 'user', content, timestamp: Date.now() };
}

function buildRuntimeContext(overrides: Record<string, unknown> = {}) {
  const rest: Record<string, unknown> = { ...overrides };
  const persistentSystemContext = (rest.persistentSystemContext as string[] | undefined) ?? [];
  delete rest.persistentSystemContext;
  const messages = (rest.messages as Message[] | undefined) ?? [
    buildMessage('user-default', 'hello'),
  ];
  delete rest.messages;

  return {
    systemPrompt: '',
    modelConfig: {
      provider: 'mock',
      model: 'test-model',
      apiKey: 'mock-key',
      temperature: 0,
      maxTokens: 4096,
    },
    toolRegistry: { getDeferredToolsSummary: vi.fn(() => '') },
    toolExecutor: {},
    messages,
    onEvent: vi.fn(),
    modelRouter: {},
    maxIterations: 1,
    workingDirectory: '/tmp',
    isDefaultWorkingDirectory: true,
    sessionId: `session-factcheck-${Math.random()}`,
    agentId: undefined,
    userId: 'user-1',
    persistMessage: vi.fn(),
    onToolExecutionLog: vi.fn(),
    circuitBreaker: {},
    antiPatternDetector: {},
    goalTracker: {},
    nudgeManager: {},
    hookMessageBuffer: { add: vi.fn(), flush: vi.fn(() => null), size: 0 },
    messageHistoryCompressor: { shouldProactivelyCompress: vi.fn(() => false) },
    autoCompressor: { getConfig: vi.fn(() => ({ preserveRecentCount: 10 })) },
    compressionPipeline: {
      evaluate: vi.fn(async (transcript: unknown[], state: CompressionState) => ({
        apiView: transcript,
        totalTokens: 0,
        layersTriggered: [],
        compressionState: state,
      })),
    },
    telemetryAdapter: undefined,
    isCancelled: false,
    isInterrupted: false,
    abortController: null,
    runAbortController: null,
    savedMessages: null,
    autoApprovePlan: false,
    enableHooks: true,
    maxStopHookRetries: 3,
    maxToolCallRetries: 2,
    externalDataCallCount: 0,
    preApprovedTools: new Set<string>(),
    enableToolDeferredLoading: false,
    maxStructuredOutputRetries: 2,
    stepByStepMode: false,
    turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn(() => []) },
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    forceFinalResponseReason: undefined,
    forceFinalResponsePrompt: undefined,
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({
      traceId: 'trace-factcheck',
      pendingRuntimeDiagnostics: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      runStartTime: Date.now(),
      totalTokensUsed: 0,
      totalToolCallCount: 0,
    } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    contextHealth: ContextHealthState.forTest({
      compressionState: new CompressionState(),
      persistentSystemContext,
    }),
    turn: TurnState.forTest({
      currentIterationSpanId: 'span-factcheck',
      currentTurnId: 'turn-factcheck',
      turnStartTime: Date.now(),
      isSimpleTaskMode: false,
      effortLevel: 'medium',
    }),
    artifact: ArtifactState.forTest(),
    memoryMode: 'off',
    ...rest,
  };
}

async function assembleSystemPrompt(overrides: Record<string, unknown> = {}): Promise<string> {
  const assembly = new ContextAssembly(buildRuntimeContext(overrides) as never);
  const modelMessages = await assembly.buildModelMessages();
  expect(modelMessages[0]?.role).toBe('system');
  return modelMessages[0].content as string;
}

describe('artifact fact-check guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('includes a Fact-check rules section in the exported artifact brief', () => {
    const brief = String(ARTIFACT_TASK_BRIEF_PROMPT);
    const section = factCheckSection(brief);

    expect(section).toContain("the user's own materials, library, and relevant local files");
    expect(section).toContain('Do not repeat a search when existing evidence is already sufficient');
    expect(section).toContain('source-lookup capabilities that are actually registered in this turn');
    expect(section).toContain('Never pretend to have searched or cited a source you did not read');
    expect(section).toContain('When no source exists or the evidence is thin, say so plainly in the final answer');
    expect(section).toContain('Keep unverified background separate from evidence-backed conclusions');
    expect(section).not.toMatch(/evidence_boundary/);
    expect(section).not.toMatch(/SOURCE_[A-Z0-9_]+/);
    expect(String(GAME_ARTIFACT_CONTRACT_PROMPT)).not.toContain(FACT_CHECK_HEADING);
  });

  it('keeps the fact-check section advisory, with carve-outs, under 900 characters', () => {
    const section = factCheckSection(String(ARTIFACT_TASK_BRIEF_PROMPT));

    expect(section.length).toBeLessThan(FACT_CHECK_BUDGET_CHARS);
    expect(section).toContain('pure layout, translation, or creative writing');
    expect(section).toContain('When the user restricted sources, stay inside them and do not add outside material');
    expect(section).toContain('Memory notes are not verified topic evidence');
    for (const pattern of FORBIDDEN_MANDATORY_SEARCH) {
      expect(section).not.toMatch(pattern);
    }
  });

  it('injects fact-check rules when needsArtifactTaskBrief matches', async () => {
    const message = 'write a project report about the 2024 launch date';
    expect(needsArtifactTaskBrief(message)).toBe(true);
    expect(needsGameArtifactContract(message)).toBe(false);

    const systemPrompt = await assembleSystemPrompt({
      messages: [buildMessage('user-match', message)],
    });

    expect(systemPrompt).toContain(FACT_CHECK_HEADING);
    expect(systemPrompt).toContain('Memory notes are not verified topic evidence');
    expect(systemPrompt).not.toContain('## Game Artifact Contract');
  });

  it('does not inject fact-check rules when needsArtifactTaskBrief does not match', async () => {
    const message = 'what time is the standup tomorrow';
    expect(needsArtifactTaskBrief(message)).toBe(false);

    const systemPrompt = await assembleSystemPrompt({
      messages: [buildMessage('user-plain', message)],
    });

    expect(systemPrompt).not.toContain(FACT_CHECK_HEADING);
    expect(systemPrompt).not.toContain('Memory notes are not verified topic evidence');
  });

  it('injects fact-check rules in non-game artifact repair mode without a matching brief', async () => {
    const message = 'thanks, that is all for now';
    expect(needsArtifactTaskBrief(message)).toBe(false);

    const systemPrompt = await assembleSystemPrompt({
      messages: [buildMessage('user-repair', message)],
      persistentSystemContext: [[
        '<artifact-validation-failed kind="document">',
        'Artifact validation failed for /tmp/quarterly-report.md.',
        '1. The date column is empty.',
        '</artifact-validation-failed>',
      ].join('\n')],
    });

    expect(systemPrompt).toContain(FACT_CHECK_HEADING);
    expect(systemPrompt).toContain('When the user restricted sources, stay inside them and do not add outside material');
    expect(systemPrompt).not.toContain('## Game Artifact Contract');
    expect(systemPrompt).not.toContain('## Game Artifact Repair Contract');
  });

  it('omits fact-check rules when the game contract replaces the brief', async () => {
    const message = '生成一个类似超级玛丽的游戏，主角是一只柯基';
    expect(needsArtifactTaskBrief(message)).toBe(true);
    expect(needsGameArtifactContract(message)).toBe(true);

    const systemPrompt = await assembleSystemPrompt({
      messages: [buildMessage('user-game', message)],
    });

    expect(systemPrompt).toContain('## Game Artifact Contract');
    expect(systemPrompt).not.toContain(FACT_CHECK_HEADING);
    expect(systemPrompt).not.toContain('Memory notes are not verified topic evidence');
  });
});
