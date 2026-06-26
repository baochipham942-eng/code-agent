// ============================================================================
// 设计画布视频生成契约（2b — ProposeVideoOps）
//
// agent 经 ProposeVideoOps 工具在会话区确认成本后，main → renderer 发起出视频请求，
// renderer 属主闸校验 + 出视频 + 落画布视频节点，回裁决。与图像提议（canvasProposal）
// 独立：视频成本确认在会话区做、永不进 ADR-027 自主信封。
// ============================================================================

/** main → renderer：出视频请求（成本已在会话区确认）。 */
export interface CanvasVideoRequest {
  requestId: string;
  /** 发起会话；renderer 属主闸用（跨会话隔离，fail-closed）。 */
  sessionId?: string;
  mode: 't2v' | 'i2v';
  /** t2v 必填；i2v 可选补充描述。 */
  prompt?: string;
  /** i2v：以画布上某张图节点为底图。 */
  baseNodeId?: string;
  /** 已解析为合法视频模型 id（main 侧用注册表解析+回退，renderer 不再二次决策）。 */
  model: string;
  /** 已 clamp 到模型允许范围的时长（秒）。 */
  durationSec: number;
}

/** renderer → main：出视频裁决。 */
export interface CanvasVideoDecision {
  requestId: string;
  status: 'applied' | 'rejected' | 'failed';
  /** 实际花费（¥），applied 时回填。 */
  costCny?: number;
  durationSec?: number;
  actualModel?: string;
  nodeId?: string;
  /** rejected（属主隔离）/failed（出图错误）原因。 */
  error?: string;
}
