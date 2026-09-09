import type { LanInvitation } from '../companion/lanProtocol';
export type CompanionManagementRequest = { action: 'status' } | { action: 'invite'; scope: string[] } | { action: 'revoke'; deviceId: string };
export type CompanionManagementResult =
  | { kind: 'status'; sessions: { id: string; title: string }[]; devices: { deviceId: string; scope: string[] }[] }
  | { kind: 'invitation'; invitation: LanInvitation }
  | { kind: 'revoked' };
