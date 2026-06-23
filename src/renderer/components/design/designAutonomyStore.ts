// ADR-027：有界自主信封的 renderer 运行态（成本权威所在，红线④）。
// 人审批信封时 grantFromApproval 建立；自动应用每张出图后 setEnvelope 持久消费；
// abort/超时/新一轮/手动停 时 clear。不挂 persist（运行时态，跨重启不续自主）。
import { create } from 'zustand';
import type { AutonomyEnvelope, AutonomyGrant, AutonomyEnvelopeRequest } from '@shared/contract';
import { grantEnvelope } from '@shared/contract/designAutonomy';

interface DesignAutonomyState {
  /** 待人审批的信封请求（agent 经 CANVAS_AUTONOMY_ASK 推来）；null=无。 */
  pendingRequest: AutonomyEnvelopeRequest | null;
  /** 当前活跃信封；null=不在自主模式（提议走 026 逐步人闸）。 */
  envelope: AutonomyEnvelope | null;
  /** 信封所属 agent run 的 sessionId——该 run 进终态即清信封（审计 HIGH-2 防孤儿）。 */
  envelopeSessionId: string | null;
  /**
   * grant 时快照的单张真实单价（¥）——预算闸用它兜底，**不在自主期依赖运行时拉自定义模型价**
   * （审计 R2-MED-1：listCustomImageModels 运行时失败会 fail-open 回落 0.14 绕过 ¥ 闸）。null=未快照。
   */
  perImageCny: number | null;
  /** 本轮自主扇出的变体组 id（首张出图建立）；null=本轮尚无变体。N 张同组供人挑。 */
  variantGroupId: string | null;
  setPendingRequest: (req: AutonomyEnvelopeRequest | null) => void;
  /** 人审批信封时建立（夹紧 + 派生默认经 grantEnvelope）；绑 sessionId + 快照单价；重置变体组；返回信封。 */
  grantFromApproval: (grant: AutonomyGrant, sessionId?: string, perImageCny?: number) => AutonomyEnvelope;
  /** 自动应用消费后持久化新信封。 */
  setEnvelope: (env: AutonomyEnvelope) => void;
  /** 首张出图后记录变体组 id（后续张归入同组）。 */
  setVariantGroupId: (id: string) => void;
  /** 作废信封（abort/超时/新一轮/手动停）；连带清变体组（不动 pendingRequest）。 */
  clear: () => void;
}

export const useDesignAutonomyStore = create<DesignAutonomyState>((set) => ({
  pendingRequest: null,
  envelope: null,
  envelopeSessionId: null,
  perImageCny: null,
  variantGroupId: null,
  setPendingRequest: (req) => set({ pendingRequest: req }),
  grantFromApproval: (grant, sessionId, perImageCny) => {
    const env = grantEnvelope(grant);
    set({
      envelope: env,
      envelopeSessionId: sessionId ?? null,
      perImageCny: typeof perImageCny === 'number' && perImageCny > 0 ? perImageCny : null,
      variantGroupId: null, // 新一轮重置变体组
    });
    return env;
  },
  setEnvelope: (env) => set({ envelope: env }),
  setVariantGroupId: (id) => set({ variantGroupId: id }),
  clear: () => set({ envelope: null, envelopeSessionId: null, perImageCny: null, variantGroupId: null }),
}));

// E2E/dev 调试钩子（同 canvasProposalStore 例）。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoDesignAutonomyStore?: typeof useDesignAutonomyStore }).__neoDesignAutonomyStore =
    useDesignAutonomyStore;
}
