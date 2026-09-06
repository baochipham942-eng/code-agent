// ============================================================================
// CLI Bootstrap - 服务初始化 (无 Electron 依赖)
// ============================================================================

// 首先注入 Electron mock（必须在任何其他导入之前）
import electronMock from './electron-mock';
import Module from 'module';

// 注入到 require cache
const originalRequire = Module.prototype.require as (this: NodeJS.Module, id: string) => unknown;
Module.prototype.require = function(this: NodeJS.Module, id: string): unknown {
  if (id === 'electron') {
    return electronMock;
  }
  return originalRequire.call(this, id);
};

// 现在可以安全导入其他模块了
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
// CLIConfigService 现在是 main ConfigService 的 read-only 视图（type alias）。
// 初始化走 main initConfigService —— 4c8b5d7d 修复尾巴：消除"配置双胞胎"。
import './config'; // 副作用：加载 .env（保持原有行为）
import type { CLIConfigService } from './config';
import { initConfigService as initMainConfigService } from '../host/services/core/configService';
import { initCLIDatabase, type CLIDatabaseService } from './database';
import { setToolLedgerSink } from '../host/tools/toolLedgerSink';
import { createCliLedgerSink } from './cliLedgerSink';
import { createCLIPermissionHandler, type CLIPermissionMode } from './permissionPolicy';
import { getCLISessionManager, type CLISessionManager } from './session';
import type { CLIConfig, CLIEventHandler } from './types';
import type { ModelConfig, Message, AgentEvent } from '../shared/contract';
import type { TelemetryAdapter } from '../shared/contract/telemetry';
import type { PlanningService } from '../host/planning';
import { SYSTEM_PROMPT } from '../host/prompts/builder';
import { applyProviderVariant } from '../host/prompts/providerVariants';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, getModelMaxOutputTokens } from '../shared/constants';
import { resolveConfiguredDefaultProvider } from '../shared/modelDefaults';
import { SWARM_TRACE } from '../shared/constants/storage';
import { composeTelemetryAdapters } from '../host/agent/metricsCollector';
import { FileSwarmTraceRepository } from '../host/services/core/repositories/FileSwarmTraceRepository';
import { getSwarmTraceWriter, installSwarmTraceWriter } from '../host/agent/swarmTraceWriter';
import {
  createRunContext,
  resolveCanonicalRunPath,
  type CreateRunContextInput,
  type RunHandle,
  type RunContext,
} from '../host/runtime/runContext';
import { getApplicationRunRegistry } from '../host/app/applicationRunRegistry';
import { createApplicationAutoAgentRecoveryHost } from '../host/app/autoAgentRecoveryHost';
import { createApplicationNativeRecoveryPorts } from '../host/app/nativeRecoveryHost';
import { initializeDurableRun, type DurableRunApplicationRuntime } from '../host/app/initializeDurableRun';
import { DurableRunRepository } from '../host/services/core/repositories/DurableRunRepository';
import { SERVICE_TIMEOUTS } from '../shared/constants/timeouts';
import { isComputerUseCapabilityInstalledSync } from '../host/plugins/builtin/computerUse/installState';
import { parseToolNameListFlag } from './utils/toolListFlags';
import type { ToolExecutionDelegate, ToolExecutorConfig } from '../host/tools/toolExecutor';
import {
  createRunTraceContext,
  type RunTraceContext,
} from '../host/telemetry/runTraceContext';

// CJS 打包态下 import.meta.url 为 undefined（esbuild 把 import.meta 替换成 {}），
// 必须优先用宿主 require；仅 ESM/tsx dev 态才回退到 createRequire。对齐 nodeModuleLoader.ts。
const cliRequire = typeof require === 'function' ? require : Module.createRequire(import.meta.url);

// 延迟导入的模块
let AgentLoop: typeof import('../host/agent/agentLoop').AgentLoop;
let ToolExecutor: typeof import('../host/tools/toolExecutor').ToolExecutor;
let getSkillDiscoveryService: typeof import('../host/services/skills').getSkillDiscoveryService;
let getTelemetryCollector: typeof import('../host/telemetry').getTelemetryCollector;

// CLI 数据目录
function getCLIDataDir(): string {
  const homeDir = os.homedir();
  const configured = process.env.CODE_AGENT_DATA_DIR?.trim();
  const dataDir = configured ? path.resolve(configured) : path.join(homeDir, '.code-agent');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

// 全局状态
let configService: CLIConfigService | null = null;
let databaseService: CLIDatabaseService | null = null;
let sessionManager: CLISessionManager | null = null;
let toolExecutor: InstanceType<typeof ToolExecutor> | null = null;
let initialized = false;
let currentTelemetrySessionId: string | null = null;
let currentAgentLoopSessionId: string | null = null;
let cliDurableRunRuntime: DurableRunApplicationRuntime | null = null;
/** MCP init 的后台 promise（未启用 = null）；首个 agent run 经 whenCLIMcpReady 等它就绪 */
let mcpInitPromise: Promise<void> | null = null;

/** 首个 agent run 的 MCP 就绪门：init 已发起时等它完成；未启用/已失败立即返回。 */
export function whenCLIMcpReady(): Promise<void> {
  return mcpInitPromise ?? Promise.resolve();
}

// CLI run/chat/serve do not initialize TaskManager, so its command-center tools
// must stay out of the model-visible tool table on this surface.
const CLI_TASK_MANAGER_TOOL_DENYLIST = [
  'delegate_task',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

type AgentLoopMessageSessionManager = Pick<CLISessionManager, 'addMessage' | 'addMessageToSession'>;

export async function persistAgentLoopMessageToSession(
  manager: AgentLoopMessageSessionManager | null,
  message: Message,
  options: {
    sessionId?: string;
    modelConfig: ModelConfig;
    workingDirectory: string;
    title?: string;
  },
): Promise<void> {
  if (!manager) return;

  if (options.sessionId) {
    await manager.addMessageToSession(options.sessionId, message, {
      title: options.title || 'CLI Session',
      modelConfig: options.modelConfig,
      workingDirectory: options.workingDirectory,
    });
    return;
  }

  await manager.addMessage(message);
}

/**
 * CLI 没有 main DatabaseService 的 swarm_* 表；file 模式显式安装 JSONL writer。
 */
export function installCLISwarmTraceWriterIfNeeded(): boolean {
  if (process.env[SWARM_TRACE.STORAGE_MODE_ENV] !== 'file') {
    return false;
  }

  const storageDir = path.join(getCLIDataDir(), SWARM_TRACE.STORAGE_DIR);
  const repo = new FileSwarmTraceRepository(storageDir);
  installSwarmTraceWriter(repo, {
    getSessionId: () => currentAgentLoopSessionId,
    defaultTrigger: 'llm-spawn',
    defaultCoordinator: 'hybrid',
  });
  return true;
}

export interface InitializeCLIServicesOptions {
  /** 显式逃生门：恢复全自动批准（含危险操作），默认 false（安全默认） */
  dangerouslySkipPermissions?: boolean;
  /** 颗粒度权限档：'auto' = 分类器判安全的自动批准并入账，其余 fail-closed 拒绝 */
  permissionMode?: CLIPermissionMode;
}

/**
 * CLI 是否需要初始化 MCP 客户端。
 * 默认不初始化（普通 run/exec 不该为 MCP 连接付启动延迟），
 * 仅 computer-use 能力包已安装时接入；旧 CODE_AGENT_ENABLE_CUA=1 会迁移成安装状态。
 * 否则 CLI 不启动 MCP，避免普通 run/exec 支付 cua-driver 启动成本。
 */
export function cliShouldInitMcp(env: NodeJS.ProcessEnv = process.env): boolean {
  return isComputerUseCapabilityInstalledSync(env) || env.CODE_AGENT_ENABLE_ARGUS_MCP === '1';
}

async function initializeCLIDurableRun(
  database: CLIDatabaseService,
  dataDir: string,
): Promise<void> {
  const db = database.getDb();
  if (!db) return;

  const repository = new DurableRunRepository(db);
  repository.migrate();
  const registry = getApplicationRunRegistry();
  cliDurableRunRuntime = await initializeDurableRun({
    registry,
    repository,
    dataDir,
    ownerId: 'cli-native-host',
    processInstanceId: `cli-${process.pid}-${randomUUID()}`,
    autoAgentRecoveryHost: createApplicationAutoAgentRecoveryHost(registry),
    nativeRecoveryPorts: createApplicationNativeRecoveryPorts(registry),
  });
}

export async function startCLIDurableRun(
  input: CreateRunContextInput,
): Promise<RunHandle | null> {
  if (!cliDurableRunRuntime?.kernel) return null;
  const registry = getApplicationRunRegistry();
  if (!await registry.waitForDurableKernel(SERVICE_TIMEOUTS.BOOTSTRAP)) return null;
  return registry.startDurable(input);
}

export async function terminalCLIDurableRun(
  handle: RunHandle,
  success: boolean,
): Promise<void> {
  const now = Date.now();
  await getApplicationRunRegistry().terminalDurable(handle.context.runId, {
    now,
    status: success ? 'completed' : 'failed',
    reason: success ? 'cli_run_completed' : 'cli_run_failed',
    event: {
      type: success ? 'cli_run_completed' : 'cli_run_failed',
      payload: {},
      recordedAt: now,
    },
  }, handle);
}

/**
 * 初始化 CLI 核心服务
 */
export async function initializeCLIServices(options: InitializeCLIServicesOptions = {}): Promise<void> {
  if (initialized) return;

  const isDebug = process.env.DEBUG === 'true' || process.argv.includes('--debug');
  const cliLog = isDebug ? (...args: unknown[]) => console.error(...args) : () => {};

  cliLog('Initializing CLI services...');

  // 设置环境变量
  const dataDir = getCLIDataDir();
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_CLI_MODE = 'true';

  // 初始化配置服务（main ConfigService 单例 — 与 webServer / Tauri 同源）
  // CLI 模式下 keytar 已通过 CODE_AGENT_CLI_MODE 守卫跳过，initialize 只读 config.json
  const mainConfigService = initMainConfigService();
  await mainConfigService.initialize();
  configService = mainConfigService; // 类型缩窄到 IReadConfigService（read-only 视图）
  cliLog('ConfigService initialized');

  // 初始化数据库
  try {
    databaseService = await initCLIDatabase();
    setToolLedgerSink(createCliLedgerSink(databaseService));
    // CLI 遥测落库：TelemetryStorage 默认依赖主 DatabaseService（CLI 刻意不初始化，
    // 全部静默丢弃）。绑定到 CLI 自己的连接（与桌面同一 SQLite 文件），
    // `neo session timeline` 的 Telemetry turns 才有真实数值。
    const cliDbHandle = databaseService.getDb();
    if (cliDbHandle) {
      const { TelemetryStorage } = await import('../host/telemetry/telemetryStorage');
      const { TelemetryCollector } = await import('../host/telemetry/telemetryCollector');
      TelemetryCollector.initInstanceWithStorage(new TelemetryStorage(cliDbHandle));
    }
    cliLog('Database initialized');
  } catch (error) {
    // 数据库失败不阻止 CLI 运行，只是缓存和会话持久化不可用
    // 原生模块 ABI 不匹配时只打一行警告，不打完整堆栈
    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.warn('Database not available (CLI mode):', msg);
  }

  if (databaseService) {
    try {
      await initializeCLIDurableRun(databaseService, dataDir);
      cliLog('Durable Run initialized for CLI');
    } catch (error) {
      const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.warn('Durable Run not available (CLI mode):', msg);
    }

    // Loop 启动收口（N-LOOP-DURABLE 刀1）：上次进程（桌面或本 CLI）退出时仍在跑的
    // loop 会永远停在 session_automations 的 running 状态。CLI 与桌面共用同一个
    // code-agent.db，这里显式传 CLI 的 db 句柄把残留收成终态并发通知，别让下一个
    // 打开该会话的人继续看见「运行中」。只收口，不恢复续跑。
    try {
      const { markInterruptedLoops } = await import('../host/loop/loopStartupRecovery');
      const lost = await markInterruptedLoops(databaseService.getDb());
      if (lost > 0) console.warn(`[CLI] Loop startup recovery: ${lost} interrupted loop(s) marked as lost`);
    } catch (error) {
      const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.warn('Loop startup recovery failed (CLI mode):', msg);
    }
  }

  // 初始化会话管理器
  sessionManager = getCLISessionManager();
  cliLog('SessionManager initialized');

  // 动态导入核心模块（相互无依赖只是赋值，并行加载省 0.1~0.3s）
  try {
    const [agentLoopModule, toolExecutorModule, protocolRegistryModule, skillsModule, telemetryModule] = await Promise.all([
      import('../host/agent/agentLoop'),
      import('../host/tools/toolExecutor'),
      import('../host/tools/protocolRegistry'),
      import('../host/services/skills'),
      import('../host/telemetry'),
    ]);
    AgentLoop = agentLoopModule.AgentLoop;

    ToolExecutor = toolExecutorModule.ToolExecutor;

    protocolRegistryModule.getProtocolRegistry();
    cliLog('Protocol tool registry initialized');

    getSkillDiscoveryService = skillsModule.getSkillDiscoveryService;

    getTelemetryCollector = telemetryModule.getTelemetryCollector;
  } catch (error) {
    console.error('Fatal: Failed to import core modules:', error);
    throw error;
  }

  // MCP（按需）：computer-use 底座开启时接入 cua-driver / argus 等默认服务器，
  // 与桌面端同一条 initMCPClient 链路。失败不阻塞 CLI（与数据库初始化同策略）。
  // 云端 MCP 服务器是 HTTP 握手（本机实测 13 个 server 串行 ~7s）——不挡首屏，
  // 与 banner/Ink 并行；首个 agent run 经 whenCLIMcpReady() 等它就绪。
  if (cliShouldInitMcp()) {
    mcpInitPromise = (async () => {
      try {
        const { initMCPClient } = await import('../host/mcp/mcpClient');
        await initMCPClient(undefined, process.cwd());
        cliLog('MCP client initialized (computer-use enabled)');
      } catch (error) {
        const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
        cliLog('MCP not available (CLI mode):', msg);
      }
    })();
  }

  // 初始化工具执行器（非交互安全默认：危险/需人工确认的权限自动拒绝，
  // --dangerously-skip-permissions 显式恢复全自动批准，
  // --permission-mode auto 走分类器裁决的中间档）
  toolExecutor = new ToolExecutor({
    requestPermission: createCLIPermissionHandler({
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      permissionMode: options.permissionMode,
      workingDirectory: process.cwd(),
    }),
    workingDirectory: process.cwd(),
    ledgerOrigin: 'cli',
  });
  cliLog('ToolExecutor initialized');

  if (installCLISwarmTraceWriterIfNeeded()) {
    cliLog('SwarmTraceWriter initialized for CLI file storage');
  }

  // Memory service removed — Light Memory (file-based) is used instead

  // 初始化 Skill 发现服务（fire-and-forget：skillMetaTool/skillCreateTool 用到时
  // 会通过 ensureInitialized 等待完成，不阻塞启动与首字响应）
  try {
    const skillDiscoveryService = getSkillDiscoveryService();
    void skillDiscoveryService.initialize(process.cwd()).then(
      () => cliLog('SkillDiscoveryService initialized'),
      (err) => cliLog('SkillDiscoveryService init failed:', err),
    );
  } catch (error) {
    cliLog('Failed to kick off SkillDiscoveryService:', error);
  }

  // 启动时探测本地 CLI 能力（fire-and-forget，不阻塞 CLI 首字响应）
  // 探到的清单后续会注入 system prompt 的 <env-capabilities> 块
  void (async () => {
    try {
      const { probeEnvCapabilities } = await import('../host/services/core/envCapabilities');
      await probeEnvCapabilities();
    } catch (error) {
      cliLog('EnvCapabilities probe failed (non-fatal):', error);
    }
  })();

  initialized = true;
  cliLog('CLI services initialized');
}

/**
 * 获取配置服务
 */
export function getConfigService(): CLIConfigService {
  if (!configService) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }
  return configService;
}

/**
 * 获取数据库服务
 */
export function getDatabaseService(): CLIDatabaseService | null {
  return databaseService;
}

/**
 * 获取会话管理器
 */
export function getToolExecutor(): InstanceType<typeof ToolExecutor> | null {
  return toolExecutor;
}

/** Build an immutable ToolExecutor instance owned by exactly one run. */
export function createRunToolExecutor(
  runContext: RunContext,
  dispatchTool?: ToolExecutionDelegate,
  requestPermission?: ToolExecutorConfig['requestPermission'],
  forcePermissionHandler = false,
): InstanceType<typeof ToolExecutor> {
  if (!toolExecutor) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }
  return toolExecutor.forRun(
    runContext,
    dispatchTool,
    requestPermission,
    forcePermissionHandler,
  ) as InstanceType<typeof ToolExecutor>;
}

/**
 * Legacy direct-tool support only. Agent runs must use createRunToolExecutor so
 * concurrent runs never mutate this process-level fallback executor.
 */
export async function syncCLIWorkingDirectory(workingDirectory: string): Promise<void> {
  if (!initialized) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }

  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  toolExecutor?.setWorkingDirectory(resolvedWorkingDirectory);

  if (getSkillDiscoveryService) {
    const skillDiscoveryService = getSkillDiscoveryService();
    await skillDiscoveryService.ensureInitialized(resolvedWorkingDirectory);
  }
}

export function getSessionManager(): CLISessionManager {
  if (!sessionManager) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }
  return sessionManager;
}


/**
 * 构建 CLI 配置
 */
export function buildCLIConfig(options: {
  project?: string;
  model?: string;
  provider?: string;
  json?: boolean;
  plan?: boolean;
  debug?: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json';
  systemPrompt?: string;
  preloadTools?: string;
  metrics?: string;
  statusFile?: string;
  tools?: string;
  disallowedTools?: string;
}): CLIConfig {
  const config = getConfigService();
  const settings = config.getSettings();

  // 工作目录
  const workingDirectory = options.project
    ? path.resolve(options.project)
    : process.cwd();

  // 模型配置：优先级 options > settings.models.* > 常量
  const provider = (options.provider as ModelConfig['provider'] | undefined)
    ?? resolveConfiguredDefaultProvider(settings.models, DEFAULT_PROVIDER);
  const providerCfg = settings.models?.providers?.[provider];
  const model = options.model || providerCfg?.model || DEFAULT_MODELS.chat;

  const modelConfig: ModelConfig = {
    provider,
    model,
    apiKey: config.getApiKey(provider) || '',
    temperature: providerCfg?.temperature ?? 0.7,
    maxTokens: providerCfg?.maxTokens ?? getModelMaxOutputTokens(model),
  };

  // Determine output format: explicit --output-format takes priority over --json
  let outputFormat: 'text' | 'json' | 'stream-json' = 'text';
  if (options.outputFormat && options.outputFormat !== 'text') {
    outputFormat = options.outputFormat;
  } else if (options.json) {
    outputFormat = 'json';
  }

  return {
    workingDirectory,
    modelConfig,
    outputFormat,
    enablePlanning: options.plan || false,
    enableHooks: true,
    debug: options.debug || false,
    autoApprovePlan: true, // CLI 模式默认自动批准 plan mode
    systemPrompt: options.systemPrompt,
    metricsPath: options.metrics,
    statusFilePath: options.statusFile,
    // --tools / --disallowed-tools：run 级工具面裁剪（精确白名单，无核心工具兜底）
    allowedToolNames: parseToolNameListFlag(options.tools),
    deniedToolNames: parseToolNameListFlag(options.disallowedTools),
  };
}

/**
 * 创建 AgentLoop 实例
 */
export function createAgentLoop(
  config: CLIConfig,
  onEvent: CLIEventHandler,
  messages: Message[] = [],
  sessionId?: string,
  extraTelemetryAdapter?: TelemetryAdapter,
  toolExecutorOverride?: { execute: (toolName: string, params: Record<string, unknown>, options: import('../host/tools/toolExecutor').ExecuteOptions) => Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }> },
  runContext?: RunContext,
  runTraceContext?: RunTraceContext,
): InstanceType<typeof AgentLoop> {
  if (!toolExecutor || !AgentLoop) {
    throw new Error('CLI services not initialized');
  }

  // System prompt (allow config-level override/append)
  // provider 变体（roadmap 2.4）：按 provider 家族追加纪律段落，与桌面侧
  // agentOrchestrator 行为对齐
  const variantBase = applyProviderVariant(
    SYSTEM_PROMPT,
    config.modelConfig.provider,
    config.modelConfig.model,
  );
  // /agent 显式选择：与 agentOrchestrator 对齐——agent 路由自带 prompt 时整体替换默认
  // 主提示词（不叠 provider 变体），config.systemPrompt 仍作追加段保留。
  const promptBase = config.agentOverride ? config.agentOverride.systemPrompt : variantBase;
  const systemPrompt = config.systemPrompt
    ? promptBase + "\n\n" + config.systemPrompt
    : promptBase;

  // 统一使用传入的 sessionId，或生成一个临时 ID
  const explicitSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
  if (runContext && explicitSessionId && explicitSessionId !== runContext.sessionId) {
    throw new Error(
      `Run/session mismatch: run ${runContext.runId} belongs to ${runContext.sessionId}, received ${explicitSessionId}`,
    );
  }
  if (
    runContext
    && resolveCanonicalRunPath(config.workingDirectory) !== runContext.cwd
  ) {
    throw new Error(
      `Run/cwd mismatch: run ${runContext.runId} owns ${runContext.cwd}, received ${config.workingDirectory}`,
    );
  }
  const effectiveSessionId = runContext?.sessionId || explicitSessionId || `cli-${Date.now()}`;
  const effectiveRunContext = runContext ?? createRunContext({
    sessionId: effectiveSessionId,
    workspace: config.workingDirectory,
  });
  const effectiveRunTraceContext = runTraceContext ?? createRunTraceContext({
    runId: effectiveRunContext.runId,
    sessionId: effectiveRunContext.sessionId,
    attempt: 1,
    ownerEpoch: 0,
    engine: 'native',
    workspace: effectiveRunContext.workspace,
    processInstanceId: `cli-${process.pid}`,
  });
  currentAgentLoopSessionId = effectiveSessionId;

  // 创建 PlanningService（如果启用规划模式）
  let planningService: PlanningService | undefined = undefined;
  if (config.enablePlanning) {
    const { createPlanningService } = cliRequire('../host/planning/planningService') as typeof import('../host/planning/planningService');
    planningService = createPlanningService(config.workingDirectory, effectiveSessionId);
    planningService.initialize().catch((err: unknown) => {
      console.error('Failed to initialize planning service:', err);
    });
    if (config.debug) {
      console.error('[Planning] Planning mode enabled');
    }
  }

  // Telemetry: 开始会话追踪
  let telemetryAdapter: TelemetryAdapter | undefined = undefined;
  if (getTelemetryCollector) {
    try {
      const collector = getTelemetryCollector();
      collector.startSession(effectiveSessionId, {
        title: 'CLI Session',
        modelProvider: config.modelConfig.provider,
        modelName: config.modelConfig.model,
        workingDirectory: config.workingDirectory,
        // CLI 会话的 session_type 也是 'chat'，与真实用户对话分不开；上线后评测按这一列剔分母。
        originKind: 'headless',
      });
      telemetryAdapter = collector.createAdapter(effectiveSessionId, 'cli');
      currentTelemetrySessionId = effectiveSessionId;
    } catch (error) {
      // Telemetry 失败不阻止运行
      console.warn('[Telemetry] Failed to start session:', (error as Error).message);
    }
  }

  // Compose with extra telemetry adapter (e.g. MetricsCollector for --metrics)
  if (extraTelemetryAdapter) {
    telemetryAdapter = telemetryAdapter
      ? composeTelemetryAdapters(telemetryAdapter, extraTelemetryAdapter)
      : extraTelemetryAdapter;
  }

  // SessionEventService: 保存完整 SSE 事件到 session_events 表（用于评测）
  let eventService: { saveEvent: (sid: string, event: AgentEvent) => void } | null = null;
  if (process.env.EVAL_DISABLED !== 'true') {
    try {
      const mod = cliRequire('../host/session/sessionEventService') as typeof import('../host/session/sessionEventService');
      eventService = mod.getSessionEventService();
    } catch { /* evaluation module not available */ }
  }

  const runToolExecutor = toolExecutorOverride
    || createRunToolExecutor(effectiveRunContext);

  // 创建 AgentLoop
  const agentLoop = new AgentLoop({
    systemPrompt,
    systemInstructions: config.systemInstructions,
    modelConfig: config.modelConfig,
    toolExecutor: runToolExecutor as InstanceType<typeof ToolExecutor>,
    messages,
    onEvent: (event: AgentEvent) => {
      if (config.debug) {
        console.error('[AgentEvent]', event.type);
      }
      onEvent(event);

      // Telemetry: 写入 telemetry_* 表（model_calls, tool_calls, turns 等）
      if (effectiveSessionId && getTelemetryCollector) {
        try {
          const collector = getTelemetryCollector();
          collector.handleEvent(effectiveSessionId, event);
        } catch { /* telemetry failure should not block agent */ }
      }
      // SessionEvents: 写入 session_events 表（完整事件流，用于评测回放）
      if (effectiveSessionId && eventService) {
        try {
          eventService.saveEvent(effectiveSessionId, event);
        } catch { /* event persistence failure should not block agent */ }
      }
    },
    enableHooks: config.enableHooks ?? true,
    planningService,
    sessionId: effectiveSessionId,
    projectId: config.projectId,
    runId: effectiveRunContext.runId,
    runTraceContext: effectiveRunTraceContext,
    workingDirectory: effectiveRunContext.cwd,
    isDefaultWorkingDirectory: false,
    autoApprovePlan: config.autoApprovePlan, // CLI 模式自动批准 plan mode
    searchEnabled: config.searchEnabled ?? true,
    // 逐轮设置随载荷走（QE-01）：此路径无复杂度 analyzer，effortLevel 缺省=TurnState 默认 high
    thinkingEnabled: config.thinkingEnabled ?? true,
    effortLevel: config.effortLevel,
    enableToolDeferredLoading: true, // 延迟加载非核心工具，减少 tool overhead
    goalContract: config.goalContract, // /goal 自治模式契约（透传给 ctx.goalMode）
    maxIterations: config.maxIterations, // 迭代数硬上限（角色主动性醒来等预算受限场景）
    toolScope: config.toolScope, // web workbench 已选连接器/MCP → 延迟工具预载
    executionIntent: config.executionIntent, // 每轮执行意图（designCanvasActive 等）→ RuntimeContext
    agentId: config.agentOverride?.id ?? 'default',
    agentName: config.agentOverride?.name ?? 'default',
    requestedAgentId: config.requestedAgentId,
    deniedToolNames: Array.from(new Set([
      ...(config.taskManagerToolsEnabled ? [] : CLI_TASK_MANAGER_TOOL_DENYLIST),
      ...(config.deniedToolNames ?? []),
      ...(config.agentOverride?.deniedToolNames ?? []),
    ])),
    allowedToolNames: config.allowedToolNames,
    telemetryAdapter,
    // CLI 消息持久化回调（包含 tool_results）
    persistMessage: async (message: Message) => {
      try {
        await persistAgentLoopMessageToSession(sessionManager, message, {
          sessionId: explicitSessionId,
          modelConfig: config.modelConfig,
          workingDirectory: config.workingDirectory,
        });
      } catch (error) {
        console.warn('[CLI] Failed to persist message:', (error as Error).message);
      }
    },
  });

  return agentLoop;
}

/**
 * 清理资源
 */
export async function cleanup(): Promise<void> {
  // cleanup 时不依赖 cliLog（可能在 close 之后调用），保留 console.error 但用 debug 守卫
  const isDebugCleanup = process.env.DEBUG === 'true' || process.argv.includes('--debug');
  if (isDebugCleanup) console.error('Cleaning up CLI services...');

  // 收尸：取消在跑 agent + 确认后台任务与 PTY 会话进程树死干净（与 webServer 停机属主同一步）
  try {
    const { reapChildProcesses } = await import('../host/tools/shell/shutdownReaper');
    await reapChildProcesses('cli_shutdown');
  } catch (error) {
    console.warn('[CLI] reapChildProcesses failed:', (error as Error).message);
  }

  // MCP：断开外部 server 子进程（cua-driver 等），避免 CLI 退出后残留孤儿进程
  if (cliShouldInitMcp()) {
    try {
      const { getMCPClient } = await import('../host/mcp/mcpClient');
      await getMCPClient().disconnectAll();
    } catch {
      // 未初始化或已断开，忽略
    }
  }

  // Telemetry: 结束会话并同步 token 使用到 sessions 表
  if (currentTelemetrySessionId && getTelemetryCollector) {
    try {
      const collector = getTelemetryCollector();
      const sessionData = collector.getSessionData(currentTelemetrySessionId);
      collector.endSession(currentTelemetrySessionId);

      // 同步 token usage 到 CLI sessions 表
      if (sessionData && sessionManager) {
        await sessionManager.updateSession(currentTelemetrySessionId, {
          lastTokenUsage: {
            inputTokens: sessionData.totalInputTokens,
            outputTokens: sessionData.totalOutputTokens,
            totalTokens: sessionData.totalTokens,
            timestamp: Date.now(),
          },
        });
      }
    } catch (error) {
      console.warn('[Telemetry] Failed to end session:', (error as Error).message);
    }
    currentTelemetrySessionId = null;
  }

  try {
    await getSwarmTraceWriter()?.drain();
  } catch (error) {
    console.warn('[CLI] Failed to drain swarm trace writer:', (error as Error).message);
  }
  currentAgentLoopSessionId = null;

  // 关闭数据库连接
  if (databaseService) {
    databaseService.close();
    databaseService = null;
  }

  initialized = false;
  if (isDebugCleanup) console.error('CLI services cleaned up');
}
