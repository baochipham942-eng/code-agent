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
// 已知边界：流式半途失联（assistant 已有部分正文）不在本判据内——那是消息级终态
// 追踪，超出本单最小修复面。

/** 健康收尾里终态广播先于 agent_complete 到达，宽限期内到了就不重灌。 */
const TERMINAL_STATUS_RECONCILE_GRACE_MS = 3_000;

function isSettledAssistantMessage(message: { role: string; content: string } | undefined): boolean {
  return message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0;
}

/**
 * 生成终态广播的对账处理器。注入 getCurrentSessionId/getLastMessage/reloadSession/
 * isRunActive/isTerminalStatus 供测试控制；schedule 注入后宽限期可虚拟推进。
 */
export function createTerminalStatusReconciler(deps: {
  getCurrentSessionId: () => string | null;
  getLastMessage: () => { role: string; content: string } | undefined;
  reloadSession: (sessionId: string) => Promise<void>;
  isRunActive: (sessionId: string) => boolean;
  isTerminalStatus: (status: string | undefined) => boolean;
  graceMs?: number;
  schedule?: (run: () => void, delayMs: number) => void;
}): (event: { sessionId: string; updates?: { status?: string } }) => void {
  const graceMs = deps.graceMs ?? TERMINAL_STATUS_RECONCILE_GRACE_MS;
  const schedule = deps.schedule ?? ((run, delayMs) => { setTimeout(run, delayMs); });
  let pendingSessionId: string | null = null;
  return ({ sessionId, updates }) => {
    if (!deps.isTerminalStatus(updates?.status)) return;
    if (sessionId !== deps.getCurrentSessionId()) return;
    if (isSettledAssistantMessage(deps.getLastMessage())) return;
    if (pendingSessionId !== null) return;
    pendingSessionId = sessionId;
    schedule(() => {
      pendingSessionId = null;
      if (sessionId !== deps.getCurrentSessionId()) return;
      if (deps.isRunActive(sessionId)) return;
      if (isSettledAssistantMessage(deps.getLastMessage())) return;
      void deps.reloadSession(sessionId);
    }, graceMs);
  };
}
