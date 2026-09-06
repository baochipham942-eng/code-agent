// ============================================================================
// Agent Adapter - Bridge between TestRunner and AgentLoop
// ============================================================================

import type { AgentInterface } from './testRunner';
import type { ToolExecutionRecord, HarnessVariantConfig, UserSimulation, EvalGoalContract, GoalRunRecord, PermissionRequestRecord, EvalCaseMemory, MemoryFileSnapshot, MemoryRecallRecord } from './types';
import { seedCaseMemory, snapshotMemoryDir } from './memoryEval';
import { createPermissionRequestRecorder } from './approvalRequestEval';
import { buildPermissionDecider, narrowScriptedPermissionHandler } from './userSimulator';
import { applyGoalEvent, buildLoopGoalContract, createGoalRunRecord } from './goalContractEval';
import type { AgentLoop } from '../agent/agentLoop';
import type { ModelProvider } from '../../shared/contract';
import type { ModelConfig } from '../../shared/contract/model';
import type { InferenceOptions } from '../model/types';
import type { ConversationExecutionIntent } from '../../shared/contract/conversationEnvelope';
import { createLogger } from '../services/infra/logger';
import { MODEL_MAX_TOKENS } from '../../shared/constants';
import { app } from '../platform';
import { runWithCompressionPipelineOverride } from '../context/compressionPipeline';
import { runWithScaffoldProfileOverrides } from '../agent/runtime/scaffoldProfile';
import { runWithMemoryModelOverride } from '../model/memoryModelOverrideScope';
import { getMockCasePolicy } from './mockEvalPolicy';
import type { PermissionRequestData } from '../tools/types';
import type { RequestPermissionResult } from '../../shared/contract/permission';
import { AgentFailureCode } from '../../shared/contract/agentFailure';
import { overrideBrowserWindowInteractionProbe } from '../platform/windowBridge';
import type { SkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import type { SessionType } from '../../shared/contract/session';
import type { DatabaseService } from '../services/core/databaseService';
import type { TelemetryCollector } from '../telemetry/telemetryCollector';
import type { ScopedCostRecorder } from '../services/core/scopedCostLimit';
import path from 'node:path';
import { createRunContext, resolveCanonicalRunPath } from '../runtime/runContext';
import { createWorkspaceScope } from '../runtime/workspaceScope';
import { getMemoryDir } from '../lightMemory/indexLoader';

const logger = createLogger('AgentAdapter');

export const EVAL_AGENT_DEFAULTS = {
  persistLongTermMemory: false,
  includeRecentConversations: false,
  skills: [] as readonly string[],
} as const;

type EvaluationSignal =
  | { type: 'skill_activated'; testId: string; name: string }
  | { type: 'memory_injected'; testId: string; id: string; entries?: string[] }
  | { type: 'memory_written'; testId: string; files: string[]; written: number }
  | { type: 'subagent_spawned'; testId: string; id: string };

type AgentLoopStateView = {
  messages?: unknown;
  toolExecutions?: unknown;
  turnCount?: unknown;
};

type ResettableAgentLoop = {
  reset?: () => unknown | Promise<unknown>;
};

type ModuleRequire = (id: string, ...args: unknown[]) => unknown;

type ModuleWithRequirePrototype = {
  prototype: {
    require: ModuleRequire;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function runWithHarnessOverrideScope<T>(
  harness: HarnessVariantConfig | undefined,
  callback: () => T,
): T {
  return runWithCompressionPipelineOverride(harness?.compressionPipeline, () =>
    runWithScaffoldProfileOverrides({
      scaffoldProfile: harness?.scaffoldProfile,
      thinkingInjection: harness?.thinkingInjection,
    }, callback),
  );
}

function getAgentLoopState(agentLoop: AgentLoop): AgentLoopStateView {
  const candidate = (agentLoop as unknown as { state?: unknown }).state;
  return isRecord(candidate) ? candidate : {};
}

function getAssistantContent(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  return message.role === 'assistant' && typeof message.content === 'string'
    ? message.content
    : undefined;
}

/**
 * Adapter that connects TestRunner to the real AgentLoop
 */
export class AgentLoopAdapter implements AgentInterface {
  private agentLoop: AgentLoop;
  private agentInfo: {
    name: string;
    model: string;
    provider: string;
  };

  constructor(
    agentLoop: AgentLoop,
    agentInfo: { name: string; model: string; provider: string }
  ) {
    this.agentLoop = agentLoop;
    this.agentInfo = agentInfo;
  }

  /**
   * Send a message to the agent and collect results
   */
  async sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    const responses: string[] = [];
    const toolExecutions: ToolExecutionRecord[] = [];
    const errors: string[] = [];
    let turnCount = 0;

    try {
      // Hook into agent events if possible
      // This is a simplified version - actual implementation depends on AgentLoop internals

      // Run the agent with the prompt
      await this.agentLoop.run(prompt);

      // After run completes, extract results from the agent state
      // This needs to be adapted based on actual AgentLoop implementation
      const state = getAgentLoopState(this.agentLoop);

      // Extract responses from messages
      if (Array.isArray(state.messages)) {
        for (const msg of state.messages) {
          const content = getAssistantContent(msg);
          if (content) {
            responses.push(content);
          }
        }
      }

      // Extract tool executions
      if (Array.isArray(state.toolExecutions)) {
        toolExecutions.push(...(state.toolExecutions as ToolExecutionRecord[]));
      }

      turnCount = typeof state.turnCount === 'number' && state.turnCount
        ? state.turnCount
        : responses.length;

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message || String(error));
      logger.error('Agent execution error', { error });
    }

    return {
      responses,
      toolExecutions,
      turnCount,
      errors,
    };
  }

  /**
   * Reset agent state for a new test
   */
  async reset(): Promise<void> {
    // Reset the agent loop state
    const agentLoop = this.agentLoop as unknown as ResettableAgentLoop;
    if (typeof agentLoop.reset === 'function') {
      await agentLoop.reset();
    }
  }

  /**
   * Get agent info
   */
  getAgentInfo(): { name: string; model: string; provider: string } {
    return this.agentInfo;
  }
}

/**
 * Mock agent for testing the test framework itself
 */
export class MockAgentAdapter implements AgentInterface {
  private responses: Map<string, {
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> = new Map();

  private agentInfo = {
    name: 'mock-gen',
    model: 'mock-model',
    provider: 'mock',
  };

  private configuredCase?: { testId: string; workingDirectory: string };
  private fixtureExecuted = false;
  private mockEvalPolicyEnabled = false;

  enableMockEvalPolicy(): void {
    this.mockEvalPolicyEnabled = true;
  }

  usesMockEvalPolicy(): boolean {
    return this.mockEvalPolicyEnabled;
  }

  configureMockCase(testId: string, workingDirectory: string): void {
    this.configuredCase = { testId, workingDirectory };
    this.fixtureExecuted = false;
  }

  /**
   * Configure mock response for a prompt
   */
  setMockResponse(
    promptPattern: string,
    response: {
      responses: string[];
      toolExecutions: ToolExecutionRecord[];
      turnCount?: number;
      errors?: string[];
    }
  ): void {
    this.responses.set(promptPattern, {
      responses: response.responses,
      toolExecutions: response.toolExecutions,
      turnCount: response.turnCount || 1,
      errors: response.errors || [],
    });
  }

  async sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    if (this.configuredCase) {
      const policy = getMockCasePolicy(this.configuredCase.testId);
      if (policy?.kind !== 'fixture') {
        throw new Error(`mock fixture 未定义: ${this.configuredCase.testId}`);
      }
      if (this.fixtureExecuted) {
        return {
          responses: [`Mock fixture follow-up acknowledged: ${prompt}`],
          toolExecutions: [],
          turnCount: 1,
          errors: [],
        };
      }
      this.fixtureExecuted = true;
      return policy.run(this.configuredCase.workingDirectory);
    }

    // Find matching mock response
    for (const [pattern, response] of this.responses) {
      if (prompt.includes(pattern) || new RegExp(pattern).test(prompt)) {
        return response;
      }
    }

    // Default response
    return {
      responses: ['Mock response for: ' + prompt],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    };
  }

  async reset(): Promise<void> {
    this.fixtureExecuted = false;
  }

  getAgentInfo(): { name: string; model: string; provider: string } {
    return this.agentInfo;
  }
}

/**
 * Standalone agent adapter that creates its own agent loop
 * Used for auto-test mode without GUI
 */
export class StandaloneAgentAdapter implements AgentInterface {
  private static _electronMockInjected = false;

  /**
   * Inject electron mock for non-Electron environments (CLI/test mode).
   * No-op if mock is already injected (e.g., by real-test-entry.ts bootstrap).
   */
  static async _ensureElectronMock(): Promise<void> {
    if (StandaloneAgentAdapter._electronMockInjected || process.versions.electron) {
      return;
    }

    // Check if platform module is available (e.g., by CJS entry point)
    try {
      if (app?.getName?.()) {
        StandaloneAgentAdapter._electronMockInjected = true;
        return;
      }
    } catch { /* not available yet */ }

    StandaloneAgentAdapter._electronMockInjected = true;

    // For ESM environments (npx tsx), use dynamic import + require patching
    try {
      const { createRequire } = await import('module');
      const _require = createRequire(import.meta.url);
      const electronMock = (await import('../../cli/electron-mock')).default;

      const Module = _require('module') as ModuleWithRequirePrototype;
      const originalRequire = Module.prototype.require;
      Module.prototype.require = function(id: string, ...args: unknown[]) {
        if (id === 'electron' || id === '../platform') {
          return electronMock;
        }
        return originalRequire.apply(this, [id, ...args]);
      };
    } catch {
      // CJS bundled mode — electron mock should already be injected by entry point
    }
  }

  private workingDirectory: string;
  private toolMode: 'all' | 'deferred';
  private currentSessionId?: string;
  private telemetrySessionActive = false;
  private modelConfig: {
    provider: string;
    model: string;
    apiKey?: string;
  } & Partial<ModelConfig>;
  private inferenceOptions?: InferenceOptions;
  private maxIterations?: number;
  private sessionRecordEnsured = false;
  /** GAP-017: harness 配置变体（对照实验维度） */
  private harness?: HarnessVariantConfig;
  /** WP1-3: A/B 对比的 candidate prompt（缺省用产线 SYSTEM_PROMPT） */
  private systemPromptOverride?: string;
  private persistLongTermMemory: boolean;
  private memoryRoutingModel?: string;
  private includeRecentConversations: boolean;
  private maxSystemPromptTokens: number;
  private skillDiscoveryService?: SkillDiscoveryService;
  private readonly skills: readonly string[];
  private readonly includeClaudeLegacySkills: boolean;
  private readonly sessionType: SessionType;
  private readonly onEvaluationSignal?: (signal: EvaluationSignal) => void;
  private readonly database?: DatabaseService;
  private readonly telemetryCollector?: TelemetryCollector;
  private evaluationTestId?: string;
  /** N-EVAL-L3-HARNESS：当前在跑的 loop，题超时时 runner 调 cancelActiveRun 真的掐掉它 */
  private activeLoop?: { cancel(reason?: 'user' | 'session-switch'): Promise<void> };
  private readonly skillActivations = new Map<string, Record<string, number>>();
  /** N-EVAL-MEMORY：本题记忆注入落账（memory_recalled 的证据源）。configureCaseMemory 每题重置。 */
  private memoryRecall?: MemoryRecallRecord;
  /** N-EVAL-MEMORY：本题 durable facts 落盘次数（case_end 的「记忆写入」列）。 */
  private memoryWrites = 0;
  /** N-EVAL-MEMORY：跑完、cleanup 之前的记忆目录快照（memory_written 的证据源）。 */
  private memorySnapshot?: MemoryFileSnapshot[];
  /** N-EVAL-MEMORY：本题的记忆声明；未声明的 case 保持 EVAL_AGENT_DEFAULTS（两向都关）。 */
  private caseMemory?: EvalCaseMemory;

  // Persisted across sendMessage() calls so multi-turn follow-ups share conversation history.
  // Cleared by reset() between cases (testRunner calls reset before each case's first prompt).
  private messages: import('../../shared/contract').Message[] = [];

  // 批 6：当前 case 的 user_simulation（testRunner 每 case 注入，reset() 清除）。
  // 只影响 requestPermission 应答；未配置时保持写死 auto-approve 的存量行为。
  private simConfig?: UserSimulation;

  // 批 6 · B6b-①：当前 case 的 goal 契约（testRunner 每 case 注入，reset() 清除）。
  // 配置后 case 以 /goal 自治模式跑（AgentLoop 建 GoalModeController）；未配置时
  // config.goalContract 为 undefined，存量行为零变化。
  private goalContract?: EvalGoalContract;
  // goal 观测事件（goal_gate / goal_complete）的行为落账，断言锚点数据
  private goalRun?: GoalRunRecord;
  private sandboxPolicy?: { redline: boolean };
  private readonly orchestration?: { allowSwarm?: boolean; spawnMaxDepth?: number };
  /** 每题子代理拉起次数（subagent_activity kind='started' 计数）。 */
  private readonly subagentSpawns = new Map<string, number>();
  private requestPermission?: (request: PermissionRequestData) => Promise<RequestPermissionResult>;

  constructor(config: {
    workingDirectory: string;
    modelConfig: {
      provider: string;
      model: string;
      apiKey?: string;
    } & Partial<ModelConfig>;
    inferenceOptions?: InferenceOptions;
    maxIterations?: number;
    toolMode?: 'all' | 'deferred';
    /** GAP-017: harness 配置变体 */
    harness?: HarnessVariantConfig;
    /** WP1-3: A/B 对比的 candidate prompt（缺省用产线 SYSTEM_PROMPT） */
    systemPromptOverride?: string;
    /** Run-scoped eval approval policy. Takes precedence over AUTO_TEST/user simulation. */
    requestPermission?: (request: PermissionRequestData) => Promise<RequestPermissionResult>;
    /** Whether this adapter may persist durable memory, learning, metadata, and summaries. */
    persistLongTermMemory?: boolean;
    /** Run-scoped model used by memory organization calls; provider/key follow this arm. */
    memoryRoutingModel?: string;
    /** Whether recent conversation summaries are visible to this adapter. */
    includeRecentConversations?: boolean;
    /** Explicit system prompt budget for this adapter. */
    maxSystemPromptTokens?: number;
    /** Exact skill names visible to this adapter. Evaluation defaults to an empty set. */
    skills?: readonly string[];
    /** Whether the explicit skill set may resolve names from Claude legacy directories. */
    includeClaudeLegacySkills?: boolean;
    /**
     * ORCHARM 实验臂的编排结构：要不要扇出子代理、最深几层。
     * allowSwarm 只影响 goal 契约 case（首轮编排引导 + workflow 预加载）；
     * spawnMaxDepth 直接进 ToolExecutor，0 = task/spawn_agent 一律 DEPTH_LIMIT。
     */
    orchestration?: { allowSwarm?: boolean; spawnMaxDepth?: number };
    sessionType?: SessionType;
    onEvaluationSignal?: (signal: EvaluationSignal) => void;
    database?: DatabaseService;
    telemetryCollector?: TelemetryCollector;
  }) {
    this.workingDirectory = config.workingDirectory;
    this.modelConfig = config.modelConfig;
    this.inferenceOptions = config.inferenceOptions;
    this.maxIterations = config.maxIterations;
    this.harness = config.harness;
    this.systemPromptOverride = config.systemPromptOverride;
    this.requestPermission = config.requestPermission;
    this.persistLongTermMemory = config.persistLongTermMemory
      ?? EVAL_AGENT_DEFAULTS.persistLongTermMemory;
    this.memoryRoutingModel = config.memoryRoutingModel;
    this.includeRecentConversations = config.includeRecentConversations
      ?? EVAL_AGENT_DEFAULTS.includeRecentConversations;
    this.maxSystemPromptTokens = config.maxSystemPromptTokens ?? 12_000;
    this.skills = config.skills ?? EVAL_AGENT_DEFAULTS.skills;
    this.includeClaudeLegacySkills = config.includeClaudeLegacySkills ?? false;
    this.orchestration = config.orchestration;
    this.sessionType = config.sessionType ?? 'chat';
    this.onEvaluationSignal = config.onEvaluationSignal;
    this.database = config.database;
    this.telemetryCollector = config.telemetryCollector;
    // harness.toolMode 优先于顶层 toolMode（对照实验显式控制工具集维度）
    this.toolMode = config.harness?.toolMode ?? config.toolMode ?? 'deferred';
  }

  private async ensureStandaloneSessionRecord(prompt: string): Promise<void> {
    if (!this.currentSessionId || this.sessionRecordEnsured) return;

    try {
      const db = this.database ?? (await import('../services/core/databaseService')).getDatabase();
      if (!db.isReady) {
        logger.warn('Evaluation session database is not ready; attempting session creation', {
          sessionId: this.currentSessionId,
        });
      }

      if (!db.getSession(this.currentSessionId)) {
        db.createSessionWithId(
          this.currentSessionId,
          {
            title: prompt.substring(0, 80) || 'Evaluation test run',
            userId: null,
            modelConfig: {
              provider: this.modelConfig.provider as ModelProvider,
              model: this.modelConfig.model,
            },
            workingDirectory: this.workingDirectory,
            type: this.sessionType,
            origin: {
              kind: 'manual',
              name: 'evaluation-runner',
              metadata: { source: 'StandaloneAgentAdapter' },
            },
            readOnly: true,
          },
        );
      }

      this.sessionRecordEnsured = true;
    } catch (error) {
      logger.debug('Failed to ensure standalone evaluation session record', {
        sessionId: this.currentSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  configureEvaluationCase(testId: string | undefined): void {
    this.evaluationTestId = testId;
  }

  /**
   * N-EVAL-L3-HARNESS：题超时时真的中止当前 run。runner 的 withTimeout 只是赛跑，不掐 loop：
   * 超时题的工具/循环会活到下一题（工作目录已清 ⇒ ENOENT ⇒ 模型转去 find / 全盘搜，
   * 09-02 首程 8 红里 7 红是它）。cancel 沿 runAbortController 把 abort 传到工具与 bash 子进程。
   */
  async cancelActiveRun(): Promise<void> {
    const loop = this.activeLoop;
    this.activeLoop = undefined;
    await loop?.cancel('user');
  }

  consumeSkillActivations(testId: string): Record<string, number> {
    const activations = this.skillActivations.get(testId) ?? {};
    this.skillActivations.delete(testId);
    return { ...activations };
  }

  consumeSubagentSpawns(testId: string): number {
    const count = this.subagentSpawns.get(testId) ?? 0;
    this.subagentSpawns.delete(testId);
    return count;
  }

  async getStructuredReplay(sessionId: string) {
    const { TelemetryQueryService, getTelemetryQueryService } = await import('../telemetry/replay/telemetryQueryService');
    return this.database
      ? new TelemetryQueryService(this.database).getStructuredReplay(sessionId)
      : getTelemetryQueryService().getStructuredReplay(sessionId);
  }

  async sendMessage(prompt: string, options?: { scopedCostRecorder?: ScopedCostRecorder }): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }> {
    let permissionRequests: PermissionRequestRecord[] | undefined;
    const responses: string[] = [];
    const toolExecutions: ToolExecutionRecord[] = [];
    const errors: string[] = [];
    let turnCount = 0;

    // Track in-flight tool calls for pairing start/end events
    const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown>; startTime: number }>();

    try {
      // Inject electron mock when not running inside Electron
      await StandaloneAgentAdapter._ensureElectronMock();

      // Dynamic imports (safe after electron mock is in place)
      const { AgentLoop } = await import('../agent/agentLoop');
      const { SYSTEM_PROMPT } = await import('../prompts/builder');
      const { ToolExecutor } = await import('../tools/toolExecutor');
      const { getTelemetryCollector } = await import('../telemetry');
      const { SkillDiscoveryService } = await import('../services/skills/skillDiscoveryService');
      const skillDiscoveryService = this.skillDiscoveryService ??= new SkillDiscoveryService({
        skillNames: this.skills,
        includeClaudeLegacySkills: this.includeClaudeLegacySkills,
      });

      // 1. System prompt

      // 2. ToolExecutor —— 显式 scripted 策略优先；否则 case permission_policy，
      // 最后才保留存量 eval auto-approve 行为。
      const permissionDecider = this.simConfig ? buildPermissionDecider(this.simConfig) : null;
      const telemetryCollector = this.telemetryCollector ?? getTelemetryCollector();
      // N-EVAL-APPROVALEVAL · B：显式 scripted 策略下把每次审批请求落账（approval_* 断言的证据源）。
      // 每个 sendMessage 一个记录器，按题隔离；没有 scripted 策略的存量路径不记（保持 undefined ⇒ 断言 fail-loud）。
      // K5：case 的 permission_policy 与显式 scripted 策略合成（narrowScriptedPermissionHandler）——
      // 先问 case 意图：case 规则命中拒 ⇒ 无论 scripted 放/拒都以模拟用户身份拒（denialSource='user'），
      // 让「先确认」题能写「用户对这条命令说不」，全局策略照常放行其余探索命令；金丝雀由此才守得住。
      // 这一拒的来源是模拟用户，不是脚本：第五程（09-02）标成 'scripted' 时
      // 模型读到「并非用户拒绝」就换三种路径写法重试同一条 rm，直到 60s 超时，审批判决整题作废。
      // N-EVAL-USERDENY-PRECEDENCE：scripted 先拒时同样要标 user——force-push 题的
      //「模拟用户说不」从没生效（dangerous_command 不匹配 scripted allow 表 ⇒ 脚本先拒），
      // 模型换 --force-with-lease 再试再被拒，第六程 12 轮爆 max_turns、第七程复现。
      const scriptedHandler = this.requestPermission;
      const narrowedHandler = scriptedHandler && permissionDecider
        ? narrowScriptedPermissionHandler(scriptedHandler, permissionDecider)
        : scriptedHandler;
      const recorder = narrowedHandler ? createPermissionRequestRecorder(narrowedHandler) : null;
      permissionRequests = recorder?.records;
      if (!this.currentSessionId) this.currentSessionId = `test-${Date.now()}`;
      // Evaluation sandboxes are the sole writable Project Source for the run.
      // Supplying the run context here turns on ToolExecutor's existing
      // path-aware write boundary (including ../ and symlink canonicalization).
      // 两个可写根，缺一不可：
      // ① 工作沙箱——题目产物落这里；
      // ② 隔离数据目录下的记忆目录——MemoryWrite 的目标由 writeTargets.ts:252 解析成
      //    `<CODE_AGENT_DATA_DIR>/memory/<file>`，不在沙箱里。少了它，开着记忆的评测题
      //    正常的 MemoryWrite 会被判 PROJECT_SOURCE_OUTSIDE_WORKSPACE，
      //    把「产品能力正常」记成一次失败（#1686 ai-review 第二轮）。
      // 只放记忆目录、不放整个数据目录：边界该多窄就多窄。
      // 记忆目录若本来就落在沙箱里（CODE_AGENT_DATA_DIR 设成沙箱子目录时会这样），
      // 再单独加一个根会撞 createWorkspaceScope 的「Project sources overlap」直接抛，
      // 整个评测起不来；这种情况下它已经被沙箱根覆盖，不必也不能再加（#1686 第三轮）。
      const canonicalWorkdir = resolveCanonicalRunPath(this.workingDirectory);
      const canonicalMemoryDir = resolveCanonicalRunPath(getMemoryDir());
      const memoryInsideSandbox = canonicalMemoryDir === canonicalWorkdir
        || canonicalMemoryDir.startsWith(`${canonicalWorkdir}${path.sep}`)
        || canonicalWorkdir.startsWith(`${canonicalMemoryDir}${path.sep}`);
      const evaluationScope = createWorkspaceScope('eval-sandbox', [
        {
          sourceId: 'eval-sandbox-root',
          path: this.workingDirectory,
          access: 'read_write',
          role: 'primary',
        },
        ...(memoryInsideSandbox ? [] : [{
          sourceId: 'eval-memory-root',
          path: canonicalMemoryDir,
          access: 'read_write' as const,
          role: 'additional' as const,
        }]),
      ]);
      // createRunContext 会 canonicalize cwd（macOS 上 /tmp → /private/tmp）。
      // ToolExecutor 构造期会校验 workingDirectory 与 runContext.cwd 一致（toolExecutor.ts:361），
      // 所以下面两处都必须用它算出来的那一份，不能一个用原始路径一个用规范化路径。
      const evaluationRunContext = createRunContext({
        runId: `eval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: this.currentSessionId,
        workspaceScope: evaluationScope,
        cwd: this.workingDirectory,
      });
      const toolExecutor = new ToolExecutor({
        requestPermission: recorder?.handler
          ?? (permissionDecider
            ? async (request) => permissionDecider({ ...request, toolName: request.tool })
            : async () => true),
        forcePermissionHandler: this.requestPermission !== undefined,
        workingDirectory: evaluationRunContext.cwd,
        runContext: evaluationRunContext,
        // 🔴 分段上线：机制先合，评测侧**暂不打开**（N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE）。
        // #1686 四轮 ai-review 一共照出 8 处，最后两轮说明它还没到能打开的程度：
        //   ① 真实子代理走 subagentToolRuntime.ts:34 自己 new ToolExecutor，不经 forRun ⇒
        //      父代理开了边界、子调用照样绕过。全仓 7 个构造点，逐个接上前，
        //      这道边界给的是「以为拦住了」的假安全，比不开更坏。
        //   ② 合法写入目的地还没枚举完（记忆目录是第二轮才发现的；产物、日志、缓存未核）。
        //      漏一个就把产品正常能力记成评测失败——评测自造假阴性。
        // 打开的前置条件写在那张单里；这里改成 true 之前先跑一遍全 held-in 真跑对照。
        restrictWritesToWorkspace: false,
        ledgerOrigin: 'eval',
        telemetryCollector,
        // ORCHARM：run 级 spawn 深度上限。缺省 undefined ⇒ SpawnGuard 生产默认；
        // 0 ⇒ 子代理工具一律 DEPTH_LIMIT（不扇出对照组）。
        ...(this.orchestration?.spawnMaxDepth !== undefined
          ? { spawnMaxDepth: this.orchestration.spawnMaxDepth }
          : {}),
      });

      // 3. Shared messages array — persisted on the adapter instance so follow-up
      // prompts within the same case see prior tool_results and assistant responses.
      // reset() clears this between cases.
      const messages = this.messages;

      // 4. Create AgentLoop with correct event handlers
      // Reuse session id across follow-ups so AgentLoop's session-scoped state stays consistent.
      if (!this.currentSessionId) this.currentSessionId = `test-${Date.now()}`;
      await this.ensureStandaloneSessionRecord(prompt);
      if (!this.telemetrySessionActive) {
        telemetryCollector.startSession(this.currentSessionId, {
          title: prompt.substring(0, 80),
          modelProvider: this.modelConfig.provider,
          modelName: this.modelConfig.model,
          workingDirectory: this.workingDirectory,
          sessionType: this.sessionType,
          // 评测真跑桥的 sessionType 缺省回落 'chat'（:455），只有来源标记能把它挡在上线后分母外。
          originKind: 'headless',
        });
        this.telemetrySessionActive = true;
      }
      const telemetryAdapter = telemetryCollector.createAdapter(this.currentSessionId, 'main');
      // B6b-①：goal 契约 case → 构建产线同款 GoalContract（goal 缺省回落 case prompt）。
      // goalRun 每次 run 重建 —— goal case 是单 prompt，多次 sendMessage 属异常路径，
      // 以最后一次 run 的落账为准。
      // 审计 R2-H1：onEvent 闭包必须绑定本次 run 的局部记录，不能动态读 this.goalRun
      // ——超时后 testRunner 已进下个 case（reset + 重建），孤儿 loop 的残余事件若走
      // this 引用会污染新 case 的落账（不可复现的假红/假绿）。
      const loopGoalContract = this.goalContract
        ? buildLoopGoalContract(this.goalContract, prompt, this.orchestration?.allowSwarm)
        : undefined;
      const goalRunForThisRun = loopGoalContract ? createGoalRunRecord() : undefined;
      // 审计 R2-H1 同款：评测信号（skill / 记忆 / 子代理）也绑定本次 run 的 testId。
      // 超时后 testRunner 已切到下一题并改了 this.evaluationTestId，孤儿 loop 迟到的
      // subagent started / skill_activated 若读 this，会把 A 题的触发记到 B 题头上。
      const testIdForThisRun = this.evaluationTestId;
      if (goalRunForThisRun) {
        this.goalRun = goalRunForThisRun;
      }
      const runtimeDatabase = this.database;
      const runtimeSessionId = this.currentSessionId;

      await runWithMemoryModelOverride(
        this.memoryRoutingModel
          ? {
              provider: this.modelConfig.provider,
              model: this.memoryRoutingModel,
              apiKey: this.modelConfig.apiKey,
              baseUrl: this.modelConfig.baseUrl,
            }
          : undefined,
        () => runWithHarnessOverrideScope(this.harness, async () => {
        const executionIntent: ConversationExecutionIntent | undefined = this.sandboxPolicy?.redline
          ? { redline: true }
          : undefined;
        const loop = new AgentLoop({
          // 必须与 executor 的 runContext.runId 同值：AgentLoop 不给就自己造一个，
          // 传到 executor.execute 会撞 RUN_CONTEXT_MISMATCH（toolExecutor.ts:466），
          // 评测里每一次工具调用都会被拒（#1686 ai-review 抓出）。
          runId: evaluationRunContext.runId,
          sessionId: this.currentSessionId,
          workingDirectory: this.workingDirectory,
          systemPrompt: this.systemPromptOverride ?? SYSTEM_PROMPT,
          modelConfig: {
            ...this.modelConfig,
            provider: this.modelConfig.provider as ModelProvider,
            model: this.modelConfig.model,
            apiKey: this.modelConfig.apiKey || '',
            temperature: this.modelConfig.temperature ?? 0.3,
            maxTokens: this.modelConfig.maxTokens ?? MODEL_MAX_TOKENS.DEFAULT,
          },
          inferenceOptions: this.inferenceOptions,
          maxIterations: this.maxIterations,
          toolExecutor,
          messages,
          // GAP-017: hooks 是 harness 对照实验维度之一（评测默认关闭）
          enableHooks: this.harness?.hooksEnabled ?? false,
          enableToolDeferredLoading: this.toolMode === 'deferred',
          autoApprovePlan: true,
          telemetryAdapter,
          systemPromptStore: telemetryCollector.systemPromptCache,
          traceDirectory: this.database
            ? path.join(path.dirname(this.database.getDbPath()), 'traces')
            : undefined,
          executionIntent,
          goalContract: loopGoalContract,
          // N-EVAL-MEMORY：case 级开关优先于 adapter 级默认。开了记忆的题两向都要开——
          // 只开读会让写入侧的题永远零写入，只开写会让召回题永远召不回。
          persistLongTermMemory: this.caseMemory?.enabled === true ? true : this.persistLongTermMemory,
          includeRecentConversations: this.caseMemory?.enabled === true ? true : this.includeRecentConversations,
          maxSystemPromptTokens: this.maxSystemPromptTokens,
          skillDiscoveryService,
          persistMessage: runtimeDatabase
            ? async (message) => {
                runtimeDatabase.addMessage(runtimeSessionId, message);
              }
            : undefined,
          turnSnapshotSink: runtimeDatabase,
          scopedCostRecorder: options?.scopedCostRecorder,
          onEvent: (event) => {
            if (this.currentSessionId) {
              telemetryCollector.handleEvent(this.currentSessionId, event);
            }
            if (goalRunForThisRun) {
              applyGoalEvent(goalRunForThisRun, event);
            }
            if (testIdForThisRun) {
              if (event.type === 'skill_activated') {
                const current = this.skillActivations.get(testIdForThisRun) ?? {};
                current[event.data.name] = (current[event.data.name] ?? 0) + 1;
                this.skillActivations.set(testIdForThisRun, current);
                this.onEvaluationSignal?.({ type: 'skill_activated', testId: testIdForThisRun, name: event.data.name });
              } else if (event.type === 'memory_injected') {
                const entries = event.data.entries ?? [];
                const recall = this.memoryRecall ?? { injections: 0, entries: [] };
                recall.injections += 1;
                for (const entry of entries) {
                  if (!recall.entries.includes(entry)) recall.entries.push(entry);
                }
                this.memoryRecall = recall;
                this.onEvaluationSignal?.({
                  type: 'memory_injected',
                  testId: testIdForThisRun,
                  id: event.data.id,
                  ...(entries.length > 0 ? { entries } : {}),
                });
              } else if (event.type === 'memory_written') {
                this.memoryWrites += event.data.written;
                this.onEvaluationSignal?.({
                  type: 'memory_written',
                  testId: testIdForThisRun,
                  files: event.data.files,
                  written: event.data.written,
                });
              } else if (event.type === 'subagent_activity' && event.data.kind === 'started') {
                this.subagentSpawns.set(
                  testIdForThisRun,
                  (this.subagentSpawns.get(testIdForThisRun) ?? 0) + 1,
                );
                this.onEvaluationSignal?.({ type: 'subagent_spawned', testId: testIdForThisRun, id: event.data.agentId });
              }
            }
            switch (event.type) {
              case 'message':
                if (event.data?.role === 'assistant' && event.data?.content) {
                  responses.push(event.data.content);
                  turnCount++;
                }
                break;
              case 'tool_call_start':
                pendingToolCalls.set(event.data.id, {
                  name: event.data.name,
                  args: event.data.arguments || {},
                  startTime: Date.now(),
                });
                break;
              case 'tool_call_end': {
                const pending = pendingToolCalls.get(event.data.toolCallId);
                if (pending) {
                  // K5：被审批层拒掉的调用没有真的执行，标出来给 no_forbidden_tool_call 的 count_denied 用。
                  const failureCode = (event.data.metadata as { failureCode?: unknown } | undefined)?.failureCode;
                  toolExecutions.push({
                    tool: pending.name,
                    input: pending.args,
                    output: event.data.output || '',
                    success: event.data.success,
                    error: event.data.error,
                    ...(failureCode === AgentFailureCode.PermissionDenied ? { permissionDenied: true } : {}),
                    duration: event.data.duration || (Date.now() - pending.startTime),
                    timestamp: Date.now(),
                  });
                  pendingToolCalls.delete(event.data.toolCallId);
                }
                break;
              }
              case 'error':
                errors.push(event.data?.message || 'Unknown error');
                break;
            }
          },
        });

        // Add user message to messages array before run() -
        // orchestrator does this but test adapter was missing it
        messages.push({
          id: `user-${Date.now()}`,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        } as import('../../shared/contract').Message);

        // N-EVAL-L3-HARNESS：eval 里没有人答问句。AskUserQuestion 靠 hasInteractiveUi() 判有没有界面，
        // eval 进程里挂着 AppWindow ⇒ 它以为有人、一等 90s+ 把整题拖超时（09-02 首程）。
        // 只在 runner 标了 evaluationTestId 的 case 内把探针置 false：工具立刻走「用户未响应」回退，
        // 轮次结束后 user_simulation 规则接管（问句路线的口径归 approval_*）。
        const restoreProbe = this.evaluationTestId !== undefined
          ? overrideBrowserWindowInteractionProbe(() => false)
          : () => {};
        this.activeLoop = loop;
        try {
        // GAP-017: context 压缩是 harness 对照实验维度之一。
        // autoCompressor 是全局单例，run 期间临时覆盖、结束后恢复，避免污染同进程其他会话。
        if (this.harness?.contextCompression !== undefined) {
          const { getAutoCompressor } = await import('../context/autoCompressor');
          const compressor = getAutoCompressor();
          const originalEnabled = compressor.getConfig().enabled;
          compressor.updateConfig({ enabled: this.harness.contextCompression });
          try {
            await loop.run(prompt);
          } finally {
            compressor.updateConfig({ enabled: originalEnabled });
          }
        } else {
          await loop.run(prompt);
        }
        } finally {
          restoreProbe();
          if (this.activeLoop === loop) this.activeLoop = undefined;
          // N-EVAL-MEMORY：只有开了记忆的题才快照。没开的题快照 undefined ⇒ memory_written
          // 判定 fail-loud，而不是拿一个空目录假装"检查过了没有敏感内容"。
          // 先等会话末尾的记忆落盘settle：那条路产线是 fire-and-forget，不等就是拍写之前的目录。
          if (this.caseMemory?.enabled === true) {
            await loop.whenSessionEndMemoryWorkSettled();
            this.memorySnapshot = await snapshotMemoryDir();
          }
        }
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message || String(error));
    }

    return {
      responses,
      toolExecutions,
      turnCount: turnCount || responses.length,
      errors,
      ...(permissionRequests ? { permissionRequests } : {}),
    };
  }

  /** 批 6：testRunner 每 case 注入 user_simulation（无模拟的 case 传 undefined 清除） */
  configureUserSimulation(sim: UserSimulation | undefined): void {
    this.simConfig = sim;
  }

  /**
   * N-EVAL-MEMORY：testRunner 每 case 注入记忆声明（无声明的 case 传 undefined 清除）。
   * seed 必须在这里落盘——调用点在 agent 起跑之前，且此时 CODE_AGENT_DATA_DIR 已经指向
   * 本题的隔离数据目录（事件桥的 IsolatedTestExecutionFactory 设的），记忆目录跟着它走。
   */
  async configureCaseMemory(memory: EvalCaseMemory | undefined): Promise<void> {
    this.caseMemory = memory;
    this.memoryRecall = undefined;
    this.memoryWrites = 0;
    this.memorySnapshot = undefined;
    if (memory?.enabled === true) await seedCaseMemory(memory);
  }

  /** 读走并清空本题的记忆落账（形态同 consumeSkillActivations）。 */
  consumeMemorySignals(testId: string): {
    memoryRecall?: MemoryRecallRecord;
    memorySnapshot?: MemoryFileSnapshot[];
    memoryWrites: number;
  } {
    void testId;
    const signals = {
      ...(this.memoryRecall ? { memoryRecall: { injections: this.memoryRecall.injections, entries: [...this.memoryRecall.entries] } } : {}),
      ...(this.memorySnapshot ? { memorySnapshot: this.memorySnapshot } : {}),
      memoryWrites: this.memoryWrites,
    };
    this.memoryRecall = undefined;
    this.memorySnapshot = undefined;
    this.memoryWrites = 0;
    return signals;
  }

  /** B6b-①：testRunner 每 case 注入 goal 契约（无契约的 case 传 undefined 清除） */
  configureGoalContract(contract: EvalGoalContract | undefined): void {
    this.goalContract = contract;
    this.goalRun = undefined;
  }

  configureSandboxPolicy(policy: { redline: boolean } | undefined): void {
    this.sandboxPolicy = policy;
  }

  /**
   * B6b-①：goal run 行为落账（goal_status / goal_evidence_gate 断言的锚点数据）。
   * 返回定格快照而非活引用（审计 R2-M1）：超时后挂起的 loop 还会向内部记录推
   * 事件，活引用会让已结案 case 的 report.json 混入结案之后的"幽灵事件"。
   */
  getGoalRunRecord(): GoalRunRecord | undefined {
    return this.goalRun ? structuredClone(this.goalRun) : undefined;
  }

  async reset(): Promise<void> {
    // Clear conversation history and session id between cases so each case starts fresh.
    // Within a case, sendMessage() reuses this.messages so follow-ups share history.
    await this.finalizeSession();
    this.messages = [];
    this.currentSessionId = undefined;
    this.sessionRecordEnsured = false;
    this.simConfig = undefined;
    this.goalContract = undefined;
    this.goalRun = undefined;
    this.sandboxPolicy = undefined;
  }

  async finalizeSession(): Promise<void> {
    if (!this.currentSessionId || !this.telemetrySessionActive) return;
    try {
      const collector = this.telemetryCollector
        ?? (await import('../telemetry')).getTelemetryCollector();
      collector.endSession(this.currentSessionId);
    } finally {
      this.telemetrySessionActive = false;
    }
  }

  getAgentInfo(): { name: string; model: string; provider: string } {
    return {
      name: 'agent-runtime',
      model: this.modelConfig.model,
      provider: this.modelConfig.provider,
    };
  }

  getSessionId(): string | undefined {
    return this.currentSessionId;
  }
}
