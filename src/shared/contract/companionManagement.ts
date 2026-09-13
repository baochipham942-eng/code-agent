import type { LanInvitation } from '../companion/lanProtocol';
export type CompanionManagementRequest = { action: 'status' } | { action: 'invite'; scope: string[] } | { action: 'revoke'; deviceId: string };
/** Status-only device fields. Pairing write path still stores deviceId + scope. */
export type CompanionPairedDevice = { deviceId: string; scope: string[]; name?: string; pairedAt?: number };
export type CompanionManagementResult =
  | { kind: 'status'; sessions: { id: string; title: string }[]; projects?: { id: string; name: string }[]; devices: CompanionPairedDevice[] }
  | { kind: 'invitation'; invitation: LanInvitation }
  | { kind: 'revoked' };
