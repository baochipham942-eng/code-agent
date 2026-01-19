// ============================================================================
// Device Types
// ============================================================================

export interface DeviceInfo {
  id: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  lastActiveAt: number;
  isCurrent: boolean;
}
