// ============================================================================
// Shutdown Finalizers - 关库之前必须做完、而没有任何活属主在做的几件事
// ============================================================================
// 这份清单原先只活在 src/host/app/lifecycle.ts 的 cleanup() 里，而那个文件零 importer、
// 从没被执行过（N-DSH-STOP1 坐实）。本模块把它接进真正活着的停机属主 webServer.shutdown()。
//
// **不在这里注册任何 SIGTERM/SIGINT 处理器**，也不往 gracefulShutdown.ts 的 onShutdown
// 注册表里挂——那张表的 setupDefaultSignalHandlers() 产品代码零调用方，挂进去等于换个
// 地方继续死。属主自己在合适的位置调本模块（与 shutdownReaper 同范式）。
//
// 时间预算：Tauri 侧 GRACEFUL_SHUTDOWN_TIMEOUT 只有 3s，到点 SIGKILL。干净关库是唯一
// 不能跳过的一步，所以关库之前的所有步骤共用一个总预算（PRE_DB_BUDGET_MS），每步再各自
// 封顶（STEP_MS）——串成一串各封顶 1s 的步骤会把关库预算吃光，退回陈旧 -wal/-shm 老坑。
// ============================================================================

import { WEB_SERVER_SHUTDOWN_TIMEOUTS } from '../shared/constants/timeouts';

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * 关库前步骤的超时封顶器。
 *
 * 与「每步各封顶 STEP_MS」相比多了一层总预算：每步的实际上限是
 * `min(STEP_MS, 总预算剩余)`，保证无论前面几步怎么卡，关库都还剩得下时间。
 * 调用点必须在 shutdown 真正开始时创建（预算从创建那一刻起算）。
 */
export function createShutdownStepCap(
  budgetMs: number = WEB_SERVER_SHUTDOWN_TIMEOUTS.PRE_DB_BUDGET_MS,
  now: () => number = Date.now,
): {
  withCap: <T>(p: Promise<T>, label: string) => Promise<T | void>;
  stepMs: () => number;
} {
  const deadline = now() + budgetMs;
  const stepMs = () =>
    Math.max(0, Math.min(WEB_SERVER_SHUTDOWN_TIMEOUTS.STEP_MS, deadline - now()));

  const withCap = <T>(p: Promise<T>, label: string): Promise<T | void> => {
    let settled = false;
    return Promise.race([
      p.then((value) => {
        settled = true;
        return value;
      }),
      delay(stepMs()).then(() => {
        // settled 守卫：定时器在步骤跑赢之后仍会触发，不守就会打出「超时了」这种
        // 与事实相反的日志——本仓排查停机问题时最不该被误导的正是这行。
        if (!settled) console.warn(`[shutdown] ${label} timed out, skipping`);
      }),
    ]);
  };

  return { withCap, stepMs };
}

// ----------------------------------------------------------------------------
// 收尾步骤清单
// ----------------------------------------------------------------------------

type Finalizer = { label: string; run: () => Promise<void> };

const FINALIZERS: Finalizer[] = [
  {
    label: 'mcp.disconnect',
    run: async () => {
      const { getMCPClient } = await import('../host/mcp/mcpClient');
      await getMCPClient().disconnectAll();
    },
  },
  {
    label: 'posthog.flush',
    run: async () => {
      const { shutdownPostHog } = await import('../host/observability/posthogNode');
      await shutdownPostHog();
    },
  },
  {
    label: 'langfuse.flush',
    run: async () => {
      const { getLangfuseService } = await import('../host/services/infra/langfuseService');
      const langfuse = getLangfuseService();
      await langfuse.cleanupAll();
      await langfuse.shutdown();
    },
  },
  {
    label: 'sessionState.cleanup',
    run: async () => {
      const { cleanupSessionStateManager } = await import('../host/session/sessionStateManager');
      cleanupSessionStateManager();
    },
  },
  {
    label: 'agentRegistry.dispose',
    run: async () => {
      const { disposeAgentRegistry } = await import('../host/agent/agentRegistry');
      await disposeAgentRegistry();
    },
  },
];

async function runOne(f: Finalizer, capMs: number, now: () => number): Promise<string> {
  const startedAt = now();
  let timedOut = false;
  try {
    await Promise.race([
      f.run(),
      delay(capMs).then(() => {
        timedOut = true;
      }),
    ]);
  } catch (error) {
    return `${f.label}=failed(${(error as Error).message})`;
  }
  return `${f.label}=${timedOut ? 'timeout' : 'ok'}(${now() - startedAt}ms)`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程还在，只是不归我们管
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 断连超时/失败后的兜底：对还活着的 MCP stdio 子进程直接 SIGKILL。
 *
 * 为什么不能只靠 disconnectAll()：StdioClientTransport.close() 的阶梯是
 * 「关 stdin → 等 2s → SIGTERM → 等 2s → SIGKILL」，而整个宽限期只有 3s。
 * 不盯 stdin 的 server（cua-driver 这类）在优雅路径上一步都走不完就被我们放弃，
 * 于是被 init 收养成孤儿——2026-07-30 孤儿 Chrome 事故的同族形状。
 * 走到这一步时优雅窗口已经用完，直接 SIGKILL 不再给宽限。
 *
 * ponytail: 只收直接子进程；server 自己再 spawn 的孙进程不管（SDK 也不管）。
 *           真出现孙进程残留，升级路径是改用 killProcessTree 那套整树收。
 */
function killSurvivingMcpChildren(pids: number[]): number {
  let killed = 0;
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      // 刚好在探活和发信号之间退了
    }
  }
  return killed;
}

async function captureMcpStdioPids(): Promise<number[]> {
  try {
    const { getMCPClient } = await import('../host/mcp/mcpClient');
    return getMCPClient().getStdioChildPids();
  } catch (error) {
    console.warn('[shutdown] failed to capture MCP child pids:', error);
    return [];
  }
}

/**
 * 跑完全部收尾步骤。五步互不依赖 ⇒ 并行，整体耗时 ≈ capMs 而不是 5 × capMs。
 *
 * **无条件打印结果**：不留痕的步骤事后无法判断跑没跑过（本仓吃过「exitReason 看着
 * 完美、shutdown 第一行日志从没打印」的亏）。每步各自记 ok / timeout / failed。
 */
export async function runShutdownFinalizers(
  capMs: number = WEB_SERVER_SHUTDOWN_TIMEOUTS.STEP_MS,
  log: (msg: string) => void = console.log,
  now: () => number = Date.now,
): Promise<void> {
  // 先记 pid 再断连——断连成功的 server 自己会退，记晚了就没得记了。
  const mcpPids = await captureMcpStdioPids();
  const results = await Promise.all(FINALIZERS.map((f) => runOne(f, capMs, now)));
  const killed = killSurvivingMcpChildren(mcpPids);
  log(`[shutdown] ${results.join(' ')} mcp.killed=${killed}/${mcpPids.length}`);
}
