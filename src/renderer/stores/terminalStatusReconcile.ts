// ============================================================================
// terminalStatusReconcile —— 终态广播对账（N-WORKDETAIL-DEFAULT-SIMPLE-FU2-FU2）
// ============================================================================
//
// 缺口形状（真跑复现，见单据证据档）：直连轮的事件只走 POST /api/run 的响应流
// （httpTransport processStream），该流若中途静默失联（半开连接/黑洞：reader 永悬、
// 无 error 事件），轮仍会在宿主侧正常收尾——commitTurn 落库 +
// AgentRunController.updateSessionStatus 在全局通道广播带终态的 session:updated。
// 广播到了页面（/api/events 健康），但现有消费者只清运行指示，不对账消息：转录区
// 停在用户消息上，答案已在 DB 却永不上屏，reload 即现（父单 47 分钟现场的形状）。
//
// 修复：收到当前会话的终态 session:updated 时，若转录区最后一条消息不是一条有正文的
// assistant 消息（终局事件没到过的形状），挂一个宽限期尾随检查——期内终局事件经健康
// 的 run 流到了（最后一条变成 assistant），什么都不做；期后仍没到，就走既有快照重灌
// 路径（switchSession force 重读消息）。宽限是必须的：宿主先广播终态、后发
// agent_complete（agent.ts 收尾顺序），无宽限会在每轮健康收尾上误触发。
//
// FU2-FU2-FU1 补口：流式半途失联（部分正文已上屏）时最后一条消息「看起来已收口」
// （assistant + 非空正文），上一版判据对它提前返回——页面永停半答案。补进「未收口
// run」证据（terminalRunGuardStore.unendedRuns：本页见过 turn_start、没见过
// agent_complete/agent_cancelled/终态 error）：排程条件放宽为「尾部未收口 或 run 未
// 收口」，fire 时同样双条件任一成立即重灌。重灌从 DB 整体换回这条消息（resume-streams
// 的告诫：重建整条，不与客户端半截拼接），灌完吞掉未收口记录，迟到的重复终态广播不得
// 再灌第二次；下一轮 turn_start 会重新登记。

/** 健康收尾里终态广播先于 agent_complete 到达，宽限期内到了就不重灌。 */
const TERMINAL_STATUS_RECONCILE_GRACE_MS = 3_000;

function isSettledAssistantMessage(message: { role: string; content: string } | undefined): boolean {
  return message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0;
}

/**
 * 生成终态广播的对账处理器。注入 getCurrentSessionId/getLastMessage/reloadSession/
 * isRunActive/isTerminalStatus/hasUnendedRun/clearUnendedRun 供测试控制；schedule
 * 注入后宽限期可虚拟推进。
 */
export function createTerminalStatusReconciler(deps: {
  getCurrentSessionId: () => string | null;
  getLastMessage: () => { role: string; content: string } | undefined;
  reloadSession: (sessionId: string) => Promise<void>;
  isRunActive: (sessionId: string) => boolean;
  isTerminalStatus: (status: string | undefined) => boolean;
  hasUnendedRun: (sessionId: string) => boolean;
  clearUnendedRun: (sessionId: string) => void;
  graceMs?: number;
  schedule?: (run: () => void, delayMs: number) => void;
}): (event: { sessionId: string; updates?: { status?: string } }) => void {
  const graceMs = deps.graceMs ?? TERMINAL_STATUS_RECONCILE_GRACE_MS;
  const schedule = deps.schedule ?? ((run, delayMs) => { setTimeout(run, delayMs); });
  const reconciled = (sessionId: string) =>
    isSettledAssistantMessage(deps.getLastMessage()) && !deps.hasUnendedRun(sessionId);
  let pendingSessionId: string | null = null;
  return ({ sessionId, updates }) => {
    if (!deps.isTerminalStatus(updates?.status)) return;
    if (sessionId !== deps.getCurrentSessionId()) return;
    if (reconciled(sessionId)) return;
    if (pendingSessionId !== null) return;
    pendingSessionId = sessionId;
    schedule(() => {
      pendingSessionId = null;
      if (sessionId !== deps.getCurrentSessionId()) return;
      if (deps.isRunActive(sessionId)) return;
      if (reconciled(sessionId)) return;
      // 重灌前吞掉未收口记录：灌入 DB 终稿后，迟到的重复终态广播不得再灌第二次。
      deps.clearUnendedRun(sessionId);
      void deps.reloadSession(sessionId);
    }, graceMs);
  };
}
