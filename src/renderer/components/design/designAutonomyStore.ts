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
  /** 本轮自主扇出的变体组 id（首张出图建立）；null=本轮尚无变体。N 张同组供人挑。 */
  variantGroupId: string | null;
  setPendingRequest: (req: AutonomyEnvelopeRequest | null) => void;
  /** 人审批信封时建立（夹紧 + 派生默认经 grantEnvelope）；重置变体组；返回建立的信封。 */
  grantFromApproval: (grant: AutonomyGrant) => AutonomyEnvelope;
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
  variantGroupId: null,
  setPendingRequest: (req) => set({ pendingRequest: req }),
  grantFromApproval: (grant) => {
    const env = grantEnvelope(grant);
    set({ envelope: env, variantGroupId: null }); // 新一轮重置变体组
    return env;
  },
  setEnvelope: (env) => set({ envelope: env }),
  setVariantGroupId: (id) => set({ variantGroupId: id }),
  clear: () => set({ envelope: null, variantGroupId: null }),
}));

// E2E/dev 调试钩子（同 canvasProposalStore 例）。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoDesignAutonomyStore?: typeof useDesignAutonomyStore }).__neoDesignAutonomyStore =
    useDesignAutonomyStore;
}
