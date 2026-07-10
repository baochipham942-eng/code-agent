// ============================================================================
// Agent Adapter - Bridge between TestRunner and AgentLoop
// ============================================================================

import type { AgentInterface } from './testRunner';
import type { ToolExecutionRecord, HarnessVariantConfig, UserSimulation, EvalGoalContract, GoalRunRecord } from './types';
import { buildPermissionDecider } from './userSimulator';
import { applyGoalEvent, buildLoopGoalContract, createGoalRunRecord } from './goalContractEval';
import type { AgentLoop } from '../agent/agentLoop';
import type { ModelProvider } from '../../shared/contract';
import type { ModelConfig } from '../../shared/contract/model';
import type { InferenceOptions } from '../model/types';
import { createLogger } from '../services/infra/logger';
import { MODEL_MAX_TOKENS } from '../../shared/constants';
import { app } from '../platform';
import { setCompressionPipelineOverride } from '../context/compressionPipeline';
import { setScaffoldProfileOverride } from '../agent/runtime/scaffoldProfile';

const logger = createLogger('AgentAdapter');

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
    // No-op for mock
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
  }) {
    this.workingDirectory = config.workingDirectory;
    this.modelConfig = config.modelConfig;
    this.inferenceOptions = config.inferenceOptions;
    this.maxIterations = config.maxIterations;
    this.harness = config.harness;
    this.systemPromptOverride = config.systemPromptOverride;
    // harness.toolMode 优先于顶层 toolMode（对照实验显式控制工具集维度）
    this.toolMode = config.harness?.toolMode ?? config.toolMode ?? 'deferred';
    // Eval-mode signal: prevents cross-case prompt contamination via recent_conversations.
    process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';
  }

  private async ensureStandaloneSessionRecord(prompt: string): Promise<void> {
    if (!this.currentSessionId || this.sessionRecordEnsured) return;

    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      if (!db.isReady) return;

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
            type: 'chat',
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

      // 1. System prompt

      // 2. ToolExecutor —— 默认 auto-approve；case 配了 permission_policy 时
      // 按 user simulator 的审批门策略应答（批 6 B6a）
      const permissionDecider = this.simConfig ? buildPermissionDecider(this.simConfig) : null;
      const toolExecutor = new ToolExecutor({
        requestPermission: permissionDecider
          ? async (request) => permissionDecider({ ...request, toolName: request.tool })
          : async () => true,
        workingDirectory: this.workingDirectory,
      });

      // 3. Shared messages array — persisted on the adapter instance so follow-up
      // prompts within the same case see prior tool_results and assistant responses.
      // reset() clears this between cases.
      const messages = this.messages;

      // 4. Create AgentLoop with correct event handlers
      // Reuse session id across follow-ups so AgentLoop's session-scoped state stays consistent.
      if (!this.currentSessionId) this.currentSessionId = `test-${Date.now()}`;
      await this.ensureStandaloneSessionRecord(prompt);
      const telemetryCollector = getTelemetryCollector();
      if (!this.telemetrySessionActive) {
        telemetryCollector.startSession(this.currentSessionId, {
          title: prompt.substring(0, 80),
          modelProvider: this.modelConfig.provider,
          modelName: this.modelConfig.model,
          workingDirectory: this.workingDirectory,
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
        ? buildLoopGoalContract(this.goalContract, prompt)
        : undefined;
      const goalRunForThisRun = loopGoalContract ? createGoalRunRecord() : undefined;
      if (goalRunForThisRun) {
        this.goalRun = goalRunForThisRun;
      }
      if (this.harness?.compressionPipeline !== undefined) {
        setCompressionPipelineOverride(this.harness.compressionPipeline);
      }
      if (this.harness?.scaffoldProfile !== undefined) {
        setScaffoldProfileOverride(this.harness.scaffoldProfile);
      }

      try {
        const loop = new AgentLoop({
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
          goalContract: loopGoalContract,
          onEvent: (event) => {
            if (this.currentSessionId) {
              telemetryCollector.handleEvent(this.currentSessionId, event);
            }
            if (goalRunForThisRun) {
              applyGoalEvent(goalRunForThisRun, event);
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
                  toolExecutions.push({
                    tool: pending.name,
                    input: pending.args,
                    output: event.data.output || '',
                    success: event.data.success,
                    error: event.data.error,
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
        if (this.harness?.compressionPipeline !== undefined) {
          setCompressionPipelineOverride(undefined);
        }
        if (this.harness?.scaffoldProfile !== undefined) {
          setScaffoldProfileOverride(undefined);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message || String(error));
    }

    return { responses, toolExecutions, turnCount: turnCount || responses.length, errors };
  }

  /** 批 6：testRunner 每 case 注入 user_simulation（无模拟的 case 传 undefined 清除） */
  configureUserSimulation(sim: UserSimulation | undefined): void {
    this.simConfig = sim;
  }

  /** B6b-①：testRunner 每 case 注入 goal 契约（无契约的 case 传 undefined 清除） */
  configureGoalContract(contract: EvalGoalContract | undefined): void {
    this.goalContract = contract;
    this.goalRun = undefined;
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
  }

  async finalizeSession(): Promise<void> {
    if (!this.currentSessionId || !this.telemetrySessionActive) return;
    try {
      const { getTelemetryCollector } = await import('../telemetry');
      getTelemetryCollector().endSession(this.currentSessionId);
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
