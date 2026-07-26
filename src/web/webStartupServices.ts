// ============================================================================
// 发行版后台服务启动接线
//
// 所有发行版都从 webServer.ts 启动。这里集中承接原先误挂在 Electron dead path
// 的后台注册，避免 webServer 本体越过 max-lines 债门，也让接线只有一个真实入口。
//
// 每项任务都是 best-effort：同步异常与异步 rejection 都只记 warn，不阻塞启动。
// dream / distill 这里只注册用户显式调用的 executor；无人值守 cron 仍有意不接。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthUser } from '../shared/contract';
import { IPC_CHANNELS } from '../shared/ipc';
import type { ConfigService } from '../host/services/core/configService';
import {
  BudgetAlertLevel,
  initBudgetService,
  type BudgetConfig,
  type BudgetService,
} from '../host/services/core/budgetService';
import { initWebEventBridge } from '../host/services/eventing/bridge';
import { createLogger } from '../host/services/infra/logger';

const logger = createLogger('WebStartupServices');

export type BroadcastSSE = (channel: string, data: unknown) => void;

type StartupConfigService = Pick<ConfigService, 'getBudgetConfig' | 'getSettings'>;

type AuthIdentityService = {
  getCurrentUser(): AuthUser | null;
  addAuthChangeCallback(callback: (user: AuthUser | null) => void): void;
};

type PostHogIdentityDependencies = {
  getDistinctId(userId: string): string;
  setCurrentDistinctId(distinctId: string | null): void;
  identifyNode(distinctId: string): void;
  broadcastSSE: BroadcastSSE;
};

type BudgetWiringDependencies = {
  initBudgetService(config: Partial<BudgetConfig>): Pick<BudgetService, 'setAlertListener'>;
};

export type WebStartupTaskName =
  | 'budget'
  | 'eventBridge'
  | 'comboRecorder'
  | 'dagEventBridge'
  | 'dagResolver'
  | 'dreamExecutor'
  | 'distillExecutor'
  | 'heartbeatService'
  | 'heartbeatLoader'
  | 'posthogIdentity'
  | 'logBridgeHandler'
  | 'fileCheckpointCleanup'
  | 'debugSnapshotCleanup'
  | 'openchronicle'
  | 'soulWatcher'
  | 'modelConsistency';

export type WebStartupTasks = Record<WebStartupTaskName, () => void | Promise<void>>;

export type WebStartupServicesOptions = {
  broadcastSSE: BroadcastSSE;
  capabilityBootstrap?: Promise<void>;
  tasks?: Partial<WebStartupTasks>;
};

function resolveDirIfUsable(dir: string | undefined): string | null {
  if (!dir) return null;
  const trimmed = dir.trim();
  if (!trimmed) return null;
  try {
    return fs.statSync(trimmed).isDirectory() ? trimmed : null;
  } catch {
    return null;
  }
}

function getWebStartupWorkingDirectory(configService: StartupConfigService): string {
  const configured = process.env.CODE_AGENT_WORKING_DIR?.trim();
  if (configured) return configured;

  const workspace = configService.getSettings().workspace;
  if (workspace) {
    const target = workspace.defaultOpenTarget ?? 'lastDirectory';
    if (target === 'fixedDirectory') {
      const pinned = resolveDirIfUsable(workspace.pinnedDirectory);
      if (pinned) return pinned;
    } else if (target === 'lastDirectory') {
      for (const recentDirectory of workspace.recentDirectories ?? []) {
        const recent = resolveDirIfUsable(recentDirectory);
        if (recent) return recent;
      }
      const fallback = resolveDirIfUsable(workspace.defaultDirectory);
      if (fallback) return fallback;
    }
  }

  const cwd = process.cwd();
  const cwdRoot = cwd ? path.parse(cwd).root : '';
  if (!cwd || cwd === cwdRoot || cwd.includes('/Contents/Resources/')) {
    return os.homedir();
  }
  return cwd;
}

/**
 * Hydrate the runtime singleton and install the renderer alert sink together.
 * Keeping them in one operation prevents a configured hard limit from blocking
 * a turn while its warning/blocked UI channel is still null.
 */
export function wireBudgetService(
  configService: Pick<StartupConfigService, 'getBudgetConfig'>,
  broadcastSSE: BroadcastSSE,
  dependencies: BudgetWiringDependencies = { initBudgetService },
): void {
  const budgetService = dependencies.initBudgetService(configService.getBudgetConfig());
  budgetService.setAlertListener((status) => {
    broadcastSSE(IPC_CHANNELS.BUDGET_ALERT, {
      level: status.alertLevel === BudgetAlertLevel.BLOCKED ? 'blocked' : 'warning',
      currentCost: status.currentCost,
      maxBudget: status.maxBudget,
      usagePercentage: status.usagePercentage,
      message: status.message,
    });
  });
}

/**
 * Keep Node and renderer analytics on the same privacy-safe stable identity.
 * The raw auth user id never crosses the PostHog boundary.
 */
export function wirePostHogIdentity(
  authService: AuthIdentityService,
  dependencies: PostHogIdentityDependencies,
): void {
  const applyIdentity = (user: AuthUser | null): void => {
    if (user) {
      const distinctId = dependencies.getDistinctId(user.id);
      dependencies.setCurrentDistinctId(distinctId);
      dependencies.identifyNode(distinctId);
      dependencies.broadcastSSE(IPC_CHANNELS.POSTHOG_IDENTITY, { distinctId });
      return;
    }
    dependencies.setCurrentDistinctId(null);
    dependencies.broadcastSSE(IPC_CHANNELS.POSTHOG_IDENTITY, { distinctId: null });
  };

  // Auth restore happens before this startup group, so reconcile current state
  // once before subscribing to future sign-in/sign-out transitions.
  applyIdentity(authService.getCurrentUser());
  authService.addAuthChangeCallback(applyIdentity);
}

function createDefaultTasks(
  configService: StartupConfigService,
  options: WebStartupServicesOptions,
): WebStartupTasks {
  const workingDirectory = getWebStartupWorkingDirectory(configService);

  return {
    budget: () => {
      wireBudgetService(configService, options.broadcastSSE);
    },

    eventBridge: () => {
      initWebEventBridge(options.broadcastSSE).start();
    },

    comboRecorder: async () => {
      const { getComboRecorder } = await import('../host/services/skills/comboRecorder');
      getComboRecorder().init();
    },

    dagEventBridge: async () => {
      const { initDAGEventBridge } = await import('../host/scheduler/dagEventBridge');
      initDAGEventBridge();
    },

    dagResolver: async () => {
      const { getDAGScheduler } = await import('../host/scheduler/DAGScheduler');
      const {
        getPredefinedAgent,
        getAgentPrompt,
        getAgentTools,
        getAgentMaxIterations,
      } = await import('../host/agent/agentDefinition');
      getDAGScheduler().setAgentResolver({
        resolve(role: string) {
          const config = getPredefinedAgent(role);
          if (!config) return undefined;
          return {
            systemPrompt: getAgentPrompt(config),
            tools: getAgentTools(config),
            maxIterations: getAgentMaxIterations(config),
          };
        },
      });
    },

    dreamExecutor: async () => {
      const { registerDreamSkillExecutor } = await import('../host/services/memory/dreamExecutor');
      registerDreamSkillExecutor();
    },

    distillExecutor: async () => {
      const { registerDistillSkillExecutor } = await import('../host/services/skills/distillExecutor');
      registerDistillSkillExecutor();
    },

    heartbeatService: async () => {
      const { initHeartbeatService, getHeartbeatService } = await import('../host/cron/heartbeatService');
      await initHeartbeatService();
      const stats = getHeartbeatService().getStats();
      logger.info('HeartbeatService initialized', { total: stats.total, healthy: stats.healthy });
    },

    heartbeatLoader: async () => {
      const { HeartbeatTaskLoader } = await import('../host/cron/heartbeatTaskLoader');
      const { getCronService } = await import('../host/cron/cronService');
      const loader = new HeartbeatTaskLoader({
        workingDirectory,
        cronService: getCronService(),
      });
      await loader.loadFromFile();
      loader.watchFile();
    },

    posthogIdentity: async () => {
      const { getAuthService } = await import('../host/services/auth/authService');
      const {
        getPostHogDistinctId,
        setCurrentDistinctId,
        identifyNode,
      } = await import('../host/observability/posthogNode');
      wirePostHogIdentity(getAuthService(), {
        getDistinctId: getPostHogDistinctId,
        setCurrentDistinctId,
        identifyNode,
        broadcastSSE: options.broadcastSSE,
      });
    },

    logBridgeHandler: async () => {
      const { logBridge } = await import('../host/mcp/logBridge');
      logBridge.setCommandHandler(async (command, params) => {
        logger.debug('LogBridge command received', { command, paramKeys: Object.keys(params) });
        if (command === 'browser_action') {
          return {
            success: false,
            error: 'REMOTE_BROWSER_ACTION_REQUIRES_SURFACE_OWNER: use the authenticated ToolExecutor browser_action path.',
          };
        }
        if (command === 'ping') {
          return { success: true, output: 'pong' };
        }
        return { success: false, error: `Unknown command: ${command}` };
      });
    },

    fileCheckpointCleanup: async () => {
      const { getFileCheckpointService } = await import('../host/services/checkpoint/fileCheckpointService');
      const count = await getFileCheckpointService().cleanup();
      if (count > 0) logger.info('Cleaned up expired file checkpoints', { count });
    },

    debugSnapshotCleanup: async () => {
      const { getDatabase } = await import('../host/services/core/databaseService');
      const database = getDatabase();
      if (!database.isReady) return;
      const retentionDays = database.getPreference<number>('debugSnapshotRetentionDays', 1) ?? 1;
      if (retentionDays <= 0) return;
      const olderThanMs = retentionDays * 24 * 60 * 60 * 1000;
      const turnCleared = database.clearSnapshots({ olderThanMs });
      const compactCleared = database.clearCompactionSnapshots({ olderThanMs });
      if (turnCleared + compactCleared > 0) {
        logger.info('Cleaned up expired debug snapshots', {
          turnCleared,
          compactCleared,
          retentionDays,
        });
      }
    },

    openchronicle: async () => {
      await options.capabilityBootstrap;
      const { initOpenchronicle } = await import('../host/services/external/openchronicleSupervisor');
      await initOpenchronicle();
    },

    soulWatcher: async () => {
      const { loadSoul, watchSoulFiles } = await import('../host/prompts/soulLoader');
      loadSoul(workingDirectory);
      watchSoulFiles(workingDirectory);
    },

    modelConsistency: async () => {
      const { validateModelConsistency } = await import('../host/model/modelValidator');
      validateModelConsistency();
    },
  };
}

function runNonBlocking(name: WebStartupTaskName, task: () => void | Promise<void>): void {
  try {
    Promise.resolve(task())
      .then(() => logger.info(`${name} startup wiring initialized`))
      .catch((error) => logger.warn(`${name} startup wiring failed (non-blocking)`, {
        error: String(error),
      }));
  } catch (error) {
    logger.warn(`${name} startup wiring failed (non-blocking)`, { error: String(error) });
  }
}

/**
 * Start every migrated service without extending the boot critical path.
 */
export function kickoffWebStartupServices(
  configService: StartupConfigService,
  options: WebStartupServicesOptions,
): void {
  const tasks = {
    ...createDefaultTasks(configService, options),
    ...options.tasks,
  };

  for (const name of Object.keys(tasks) as WebStartupTaskName[]) {
    runNonBlocking(name, tasks[name]);
  }
}
