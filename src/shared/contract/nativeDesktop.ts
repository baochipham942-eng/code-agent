export type NativePermissionKind =
  | 'microphone'
  | 'screenCapture'
  | 'accessibility'
  | 'notifications'
  | 'automation';

export type NativePermissionState =
  | 'unknown'
  | 'denied'
  | 'granted'
  | 'needs_restart'
  | 'wrong_bundle_id'
  | 'unsupported';

export interface NativePermissionStatus {
  kind: NativePermissionKind;
  label: string;
  status: NativePermissionState;
  required: boolean;
  detail?: string | null;
  action?: string | null;
  bundleId?: string | null;
}

export interface NativePermissionSnapshot {
  schemaVersion: 1;
  platform: string;
  checkedAtMs: number;
  bundleId?: string | null;
  permissions: NativePermissionStatus[];
  summary: {
    granted: number;
    denied: number;
    needsRestart: number;
    wrongBundleId: number;
    unknown: number;
    unsupported: number;
  };
}
