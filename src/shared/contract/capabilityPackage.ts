export type CapabilityPackagePermission =
  | 'filesystem'
  | 'network'
  | 'shell'
  | 'clipboard'
  | 'notification'
  | 'storage';

export interface CapabilityPackagePreview {
  token: string;
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: CapabilityPackagePermission[];
  toolNames: string[];
  sourceKind: 'directory' | 'manifest' | 'zip';
  sourceLabel: string;
  replacesInstalledVersion?: string;
  sandbox: {
    passed: true;
    summary: string;
  };
  expiresAt: number;
}

export interface InstalledCapabilityPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: CapabilityPackagePermission[];
  state: 'inactive' | 'activating' | 'active' | 'error' | 'disabled';
  toolNames: string[];
  error?: string;
}

export interface CapabilityPackageInstallResult {
  id: string;
  version: string;
  toolNames: string[];
  replacedVersion?: string;
}

export type CapabilityPackageResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; cancelled?: boolean };
