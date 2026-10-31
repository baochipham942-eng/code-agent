// ============================================================================
// ChannelCloudRunPort — 通道通往云端 run 账本的最小端口（ADR-087 S4B）
// ============================================================================
// host/channels 不得 import src/web；服务模式装配（src/web/routes/cloudChannelRun.ts）
// 启动时把实现注册进来。桌面态不注册（getChannelCloudRunPort() === null），
// 入站消息走原有本地路径。这是「通道要启动云端 run 只能经 admit」（ADR-087
// 合同 3）在桥接层的落点：端口只有 admit/settle/waitForSettled 三个面，
// 没有任何直达执行体的旁路。
// ============================================================================

export interface ChannelCloudRunAdmission {
  record: { runId: string; sessionId: string; state: string };
  duplicate: boolean;
  position: { queuePosition: number; ahead: number } | null;
}

interface ChannelCloudRunAdmitInput {
  sessionId: string;
  /** ADR-087 幂等键 (accountId, channelDeliveryId) 的通道侧半边。 */
  channelDeliveryId: string;
  /** JSON-safe 的通道入站载荷（见 channelCloudAdmission.ts 的编码白名单）。 */
  requestJson: string;
}

export interface ChannelCloudRunPort {
  /** 桥接层的唯一准入口；throw CloudRunAccountRequiredError 表示云端账号未就绪。 */
  admit(input: ChannelCloudRunAdmitInput): ChannelCloudRunAdmission;
  /** 桥接层自己跑完一轮后收线；排队行的提升轮同样经这里收线。 */
  settle(runId: string, state: 'succeeded' | 'failed'): void;
  /**
   * 等一条排队行被提升执行并收线（终态）。调用方持有 IngressPipeline 的
   * 会话锁等在这里：该会话的真实回复发出前，同会话后续消息不会插队。
   */
  waitForSettled(runId: string): Promise<void>;
}

let port: ChannelCloudRunPort | null = null;

/** 服务模式装配时注册；传 null 复位（测试隔离用）。 */
export function setChannelCloudRunPort(next: ChannelCloudRunPort | null): void {
  port = next;
}

export function getChannelCloudRunPort(): ChannelCloudRunPort | null {
  return port;
}
