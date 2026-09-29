// ============================================================================
// StartupAssemblyGuard — 启动装配期取消闸（N-STOP-DURING-STARTUP）
// ============================================================================
// initializeRun 的首轮上下文装配（hook 初始化 / 技能发现 / 并行判断 / AGENTS.md /
// 近期会话 / seed memory / 桌面活动理解）历史上不检查取消信号：启动期点「停止」
// 要等全部装配步骤跑完、主循环首轮才看到 abort（真机 8~22s）。这里提供两种检查点：
//  - isStartupAborted：步骤之间的同步检查（每个 await 边界一次），命中即由调用方
//    从 initializeRun return null 退出；
//  - raceStartupStep：慢步骤与 run 级 AbortSignal 竞速，取消/中断已发生时即刻
//    返回 undefined，不再等步骤完成（步骤本体继续在后台收尾，其结果被丢弃）。
// 语义约束：只在「取消/中断已发生」时短路；步骤自身的失败仍按原路径 reject，
// 不吞错、不新增终态——退出后由 run() 走既有 cancelled/interrupted 收尾
// （finalizeRun → agent_cancelled → 编排侧 user_stop 停靠）。

import type { RuntimeContext } from './runtimeContext';

export function isStartupAborted(ctx: RuntimeContext): boolean {
  return ctx.control.isCancelled || ctx.control.isInterrupted;
}

/**
 * raceStartupStep 的 undefined 只会因取消/中断出现（步骤自身 resolve 的值原样透传，
 * reject 原样抛出）。此谓词在「取消/中断」时返回 true 让调用方立即退出装配，
 * 同时把 false 分支的值收窄回 T——比 `|| !x` 更能表达「undefined 即取消」的契约。
 */
export function startupStepAbandoned<T>(ctx: RuntimeContext, stepResult: T | undefined): stepResult is undefined {
  return stepResult === undefined && isStartupAborted(ctx);
}

export async function raceStartupStep<T>(ctx: RuntimeContext, step: Promise<T>): Promise<T | undefined> {
  const signal = ctx.control.runAbortController?.signal;
  if (!signal) return step;
  if (signal.aborted) {
    // 步骤被放弃后若再 reject（如推理 AbortError），已没有消费者——挂 no-op catch
    // 防止 unhandled rejection 噪音。
    step.catch(() => {});
    return undefined;
  }
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      step.catch(() => {});
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    step.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
