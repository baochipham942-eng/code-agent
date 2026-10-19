// ============================================================================
// testRunnerAgentInterface - TestRunner 的 agent 交互契约与执行上下文类型
//（自 testRunner.ts 拆出，正文 verbatim）
// ============================================================================

import type {
  ToolExecutionRecord,
  UserSimulation,
  EvalGoalContract,
  GoalRunRecord,
  PermissionRequestRecord,
  EvalCaseMemory,
  CaseMemorySignals,
  CaseSkillSignals,
  HandoffProposalRecord,
} from './types';
import type { StructuredReplay } from '../../shared/contract/evaluation';
import type { ScopedCostRecorder } from '../services/core/scopedCostLimit';

/**
 * Interface for agent interaction
 * This abstracts away the actual agent implementation
 */
export interface AgentInterface {
  /** Send a message to the agent and get response */
  sendMessage(prompt: string, options?: { scopedCostRecorder?: ScopedCostRecorder }): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
    /** adapter 接了审批记录器时才有；缺席 ⇒ approval_* 断言 fail-loud */
    permissionRequests?: PermissionRequestRecord[];
  }>;
  /** Reset the agent state for a new test */
  reset(): Promise<void>;
  /** Get current agent info */
  getAgentInfo(): { name: string; model: string; provider: string; endpoint?: string };
  /** Get the current session ID (optional) */
  getSessionId?(): string | undefined;
  /** Flush/end the current telemetry session after a case completes (optional) */
  finalizeSession?(): Promise<void>;
  /**
   * 批 6：接收当前 case 的 user_simulation 配置（审批门 permission_policy 注入用）。
   * runner 每个 case 都会调用（无模拟时传 undefined 清除上个 case 的配置）。
   */
  configureUserSimulation?(sim: UserSimulation | undefined): void;
  /**
   * N-EVAL-L3-HARNESS：题超时时 runner 调它真的掐掉在跑的 run（withTimeout 只是赛跑）。
   * 不实现的 adapter 维持旧行为（loop 活到下一题）。
   */
  cancelActiveRun?(): Promise<void>;
  /**
   * B6b-①：接收当前 case 的 goal 契约（case 以 /goal 自治模式跑）。
   * runner 每个 case 都会调用（无契约时传 undefined 清除上个 case 的配置）。
   */
  configureGoalContract?(contract: EvalGoalContract | undefined): void;
  /**
   * N-EVAL-MEMORY：接收当前 case 的记忆声明（无声明的 case 传 undefined 清除上一题）。
   * 实现方负责在这一刻把 seed 落进本题的记忆目录——调用点在 agent 起跑之前。
   */
  configureCaseMemory?(memory: EvalCaseMemory | undefined): Promise<void>;
  /** Inject per-case sandbox policy, currently used to force redline cases offline. */
  configureSandboxPolicy?(policy: { redline: boolean } | undefined): void;
  /** mock adapter 接收 evaluator 侧已分类的 fixture case。 */
  configureMockCase?(testId: string, workingDirectory: string): void;
  /** 仅正式 core mock eval 显式启用；普通 provider=mock 的测试替身不进入评测策略。 */
  usesMockEvalPolicy?(): boolean;
  /** B6b-①：goal run 行为落账（goal_status / goal_evidence_gate 断言的锚点数据） */
  getGoalRunRecord?(): GoalRunRecord | undefined;
  /** Bind runtime capability signals to the case that is currently executing. */
  configureEvaluationCase?(testId: string | undefined): void;
  /** Read and clear the real skill activations accumulated for one case. */
  consumeSkillActivations?(testId: string): Record<string, number>;
  /** N-EVAL-MEMORY：读走并清空本题的记忆落账（memory_recalled / memory_written 的证据源）。 */
  consumeMemorySignals?(testId: string): CaseMemorySignals;
  /**
   * N-SKILL-TRIGGER-EVAL：读走并清空本题 skill 触发落账与上下文集（skill_* 断言的证据源）。
   * 消费即清——只读 peek 会把台账留到下一 trial，触发计数跨题累积
   * （ai-review PR#2019 Important 1）。缺席 ⇒ skill_* 断言 fail-loud。
   */
  // N-EVAL-FAILURE-AUTOHARVEST：collectHandoffProposals = 采集本会话 run 窗口内落库的 handoff
  // 提案（handoff_* 断言的证据源；只在 case 声明 handoff_* 断言时被调，见 timeoutExpectations
  // 的 collectDeclaredHandoffProposals 闸；返回 undefined = 没有证据源 ⇒ 断言 fail-loud）。
  // 与上行同行是 max-lines 债务门所迫（本文件基线正好 1000 有效行），拆行即红，勿拆。
  consumeSkillSignals?(testId: string): Promise<CaseSkillSignals>; collectHandoffProposals?(since: number): Promise<HandoffProposalRecord[] | undefined>;
  consumeSubagentSpawns?(testId: string): number;
  getStructuredReplay?(sessionId: string): Promise<StructuredReplay | null>;
}

export type AgentFactory = (context: {
  workingDirectory: string;
}) => AgentInterface | Promise<AgentInterface>;

export interface WorkerDirectory {
  workingDirectory: string;
  cleanup(): void | Promise<void>;
}

export type WorkerDirectoryFactory = () => WorkerDirectory | Promise<WorkerDirectory>;

export interface TestExecutionContext {
  agent: AgentInterface;
  workingDirectory: string;
}

interface IsolatedTestExecutionContext extends TestExecutionContext {
  cleanup(): void | Promise<void>;
}

export type IsolatedTestExecutionFactory = () =>
  | IsolatedTestExecutionContext
  | Promise<IsolatedTestExecutionContext>;

export interface ParallelWorker extends TestExecutionContext {
  cleanup(): void | Promise<void>;
}
