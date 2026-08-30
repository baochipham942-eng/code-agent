export type CapabilityPackagePermission =
  | 'filesystem'
  | 'network'
  | 'shell'
  | 'clipboard'
  | 'notification'
  | 'storage'
  | 'accessibility'
  | 'microphone'
  | 'screen-recording';

export interface CapabilityPackagePreview {
  token: string;
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: CapabilityPackagePermission[];
  toolNames: string[];
  surface: 'tools' | 'internal-feature';
  sourceKind: 'directory' | 'manifest' | 'zip' | 'bundled';
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
  state: 'available' | 'inactive' | 'activating' | 'active' | 'error' | 'disabled';
  toolNames: string[];
  surface: 'tools' | 'internal-feature';
  internalFeature?: {
    id: string;
    label: string;
    rendererEntry: string;
  };
  error?: string;
}

export interface CapabilityPackageInstallResult {
  id: string;
  version: string;
  toolNames: string[];
  surface: 'tools' | 'internal-feature';
  replacedVersion?: string;
}

export type CapabilityPackageResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; cancelled?: boolean };
