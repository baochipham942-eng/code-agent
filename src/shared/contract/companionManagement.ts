import type { LanInvitation } from '../companion/lanProtocol';
export type CompanionManagementRequest = { action: 'status' } | { action: 'invite'; scope: string[] } | { action: 'revoke'; deviceId: string };
/** Status-only device fields. Pairing write path still stores deviceId + scope. scopeEpoch feeds relay routeToken derivation. */
export type CompanionPairedDevice = { deviceId: string; scope: string[]; scopeEpoch: number; name?: string; pairedAt?: number };
/**
 * 跨网连接（relay）状态块，供设置页「手机」区展示。可选字段：旧 host 不带，renderer 需容忍缺省。
 * accountError 只进日志语义（最近一次账号通道拨号失败的码），不许原样展示给用户。
 */
export type CompanionRelayStatus = {
  /** 这台电脑是否配了中继（companion-relay.json 存在且启用）。 */
  configured: boolean;
  /** 共享凭据通道（老手机走的那条）连接态。 */
  legacy: 'connected' | 'disconnected';
  /** 账号通道：off=没配中继；signedOut=没登录 Neo 账号；connecting=已登录未连上；connected=已连上。 */
  account: 'off' | 'signedOut' | 'connecting' | 'connected';
  accountError?: string;
};
export type CompanionManagementResult =
  | { kind: 'status'; sessions: { id: string; title: string }[]; projects?: { id: string; name: string }[]; devices: CompanionPairedDevice[]; relay?: CompanionRelayStatus }
  | { kind: 'invitation'; invitation: LanInvitation }
  | { kind: 'revoked' };
