// ============================================================================
// memberInput — 用户在成员视图里直接给一位正在干活的成员补话/改道（N-SUBAGENT-INPUT）
// ----------------------------------------------------------------------------
// 渲染层只认一个入口（domain:agent · sendMemberInput）；宿主按成员类型三分路由到
// 三条现成通道：专家团成员 → swarm:send-user-message（协调器入队 / SpawnGuard 回退）；
// 普通 spawn 子代理 → 同一处理器，没有 run 作用域时退到 SpawnGuard 按会话直投；
// 委派后台任务 → SessionCommandCenter.steer（排队中追加到 prompt，运行中 interruptAndContinue）。
// 回执三态：已送到 / 已读到 / 没送到（带原因）。
// ============================================================================

import type { RuntimeInputMode } from './conversationEnvelope';

/** 与 agentRows 的 AgentRowKind 同口径：expert=专家团成员，agent=agentTree 节点，task=后台任务。 */
export type MemberInputKind = 'expert' | 'agent' | 'task';

export interface MemberInputRequest {
  sessionId: string;
  /** 专家团 / spawn 成员所属 swarm run；后台任务不需要。 */
  runId?: string;
  memberId: string;
  /** 用户面名字，只用于主对话折叠记录与回执文案。 */
  memberName: string;
  kind: MemberInputKind;
  message: string;
  /** Enter=supplement（补话，下一步读到）；⌘Enter=redirect（改道）。 */
  mode: RuntimeInputMode;
  messageId?: string;
  timestamp?: number;
}

type MemberInputRejectReason =
  /** 成员已收工/失败/取消：不排队，回主会话再派 */
  | 'finished'
  /** 三条通道都找不到这位成员 */
  | 'not_found';

export type MemberInputReceipt =
  | {
      outcome: 'delivered';
      /**
       * now：已注入该 run 的模型上下文（后台任务 steer 成功）→ 界面显示「已读到」；
       * next_step：进了成员收件箱，下一轮迭代前抽干 → 「已送到」；
       * queued：任务还没开工，已追加到它的任务书 → 「已送到」。
       */
      effect: 'now' | 'next_step' | 'queued';
      /** 是否已落成主对话里的一条记录（团队路径落用户消息；后台任务路径由运行时落 isMeta）。 */
      persisted: boolean;
    }
  | { outcome: 'rejected'; reason: MemberInputRejectReason };

/** 主对话里那条折叠记录的标记（isMeta 消息上）。 */
export interface MemberInputMessageMetadata {
  memberId: string;
  memberName: string;
  mode: RuntimeInputMode;
}
