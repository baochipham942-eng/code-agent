// ============================================================================
// N-PERM-POLICYVERSION ②③ — 权限变更来源标记 + 变更流水（mutation journal）
// ============================================================================
//
// 决议（编排 2026-09-30，方案 B）：外部来源（config 文件编辑/热重载、hook、plugin、
// 项目设置）的**放宽**不作用于已开始的 run，下一个 run 起生效；用户在 UI 里的放宽
// （审批卡的 always allow、会话档切换）立即生效；收紧无论来源立即生效。
// 判定需要知道「每次变更是谁干的」：这里只存 {seq, source, kind, id}，不做任何判定。
//
// 本模块零依赖（不 import 引擎/沙箱），policyEngine / modes / execPolicy 都只朝这里
// 单向写流水，runPolicySnapshot 再单向读——不制造环。
//
// 缺省 'external'（向冻结方向 fail-closed）：忘传来源的调用点自动落进「冻结」一侧，
// 不会把一次外部放宽误判成立即生效。

/** 谁改的权限：用户在 UI 里操作 = 'user-ui'；其余（文件热重载/hook/plugin/缺省）= 'external'。 */
export type PolicyMutationSource = 'user-ui' | 'external';

/** 变更种类：PolicyEngine 规则增删 / exec-policy 前缀规则 / 权限档（会话或全局）。 */
type PolicyMutationKind = 'rule-add' | 'rule-remove' | 'exec-add' | 'mode';

export interface PolicyMutationEntry {
  /** 单调递增序号，快照用它在 run 起点画水位线。 */
  seq: number;
  source: PolicyMutationSource;
  kind: PolicyMutationKind;
  /** 规则 id（user-<action>-<text>）或 exec 前缀（pattern 空格连接）或 sessionId / 'global'。 */
  id: string;
  /** 变更后的动作：allow=放宽方向；deny/prompt/forbidden=收紧方向。mode 变更无此字段。 */
  action?: 'allow' | 'deny' | 'prompt' | 'forbidden';
}

let nextSeq = 1;
let entries: PolicyMutationEntry[] = [];

/** 记一次变更，返回它的 seq。 */
export function recordPolicyMutation(
  entry: Omit<PolicyMutationEntry, 'seq'>,
): number {
  const seq = nextSeq++;
  entries.push({ ...entry, seq });
  return seq;
}

/** 水位线之后（不含）的全部变更。 */
export function policyMutationsSince(watermark: number): PolicyMutationEntry[] {
  return entries.filter((entry) => entry.seq > watermark);
}

/** 当前已发出的最大 seq（run 起点的水位线）。 */
export function currentPolicyMutationSeq(): number {
  return nextSeq - 1;
}

/**
 * 丢弃 seq ≤ ceilSeq 的旧流水。只在「没有任何活跃快照还需要它们」时由
 * runPolicySnapshot 调用，防止长会话里流水无界增长。
 */
export function trimPolicyMutationsAtOrBelow(ceilSeq: number): void {
  entries = entries.filter((entry) => entry.seq > ceilSeq);
}
