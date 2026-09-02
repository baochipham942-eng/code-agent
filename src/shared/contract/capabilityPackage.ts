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

export type PluginActivationMode = 'run' | 'update';

export type PluginPackageApprovalState = 'pending' | 'approved' | 'denied';

interface InstalledPluginPackageVersion {
  packageId: string;
  version: string;
  approval: PluginPackageApprovalState;
  lastRunState?: 'activating' | 'awaiting-client' | 'succeeded' | 'failed';
  error?: string;
}

export interface CapabilityPackagePreview {
  token: string;
  id: string;
  packageId: string;
  mode: PluginActivationMode;
  approvalRequired: boolean;
  name: string;
  version: string;
  description: string;
  permissions: CapabilityPackagePermission[];
  toolNames: string[];
  surface: 'tools' | 'internal-feature' | 'ui';
  sourceKind: 'directory' | 'manifest' | 'zip' | 'bundled';
  sourceLabel: string;
  sourceTrust: {
    level: 'signed' | 'unsigned';
    reason: string;
    keyId?: string;
  };
  requestedUiSlots: string[];
  replacesInstalledVersion?: string;
  sandbox: {
    passed: true;
    summary: string;
  };
  expiresAt: number;
}

export interface InstalledCapabilityPackage {
  id: string;
  packageId?: string;
  currentPackageId?: string;
  nextPackageId?: string;
  runningPackageId?: string;
  pluginRunId?: string;
  packages?: InstalledPluginPackageVersion[];
  name: string;
  version: string;
  description: string;
  permissions: CapabilityPackagePermission[];
  state: 'available' | 'inactive' | 'activating' | 'active' | 'error' | 'disabled';
  toolNames: string[];
  surface: 'tools' | 'internal-feature' | 'ui';
  internalFeature?: {
    id: string;
    label: string;
    sdkVersion: {
      host: string;
      renderer: string;
    };
    rendererEntry: string;
    rendererStyles: string;
    hostEntry: string;
    loadedHash?: string;
    builtFrom?: {
      appVersion: string;
      commit: string;
    };
  };
  pluginUi?: {
    sdkVersion: {
      renderer: string;
    };
    rendererEntry: string;
    rendererStyles: string;
    loadedHash: string;
    sourceTrust: {
      level: 'signed' | 'unsigned';
      reason: string;
      keyId?: string;
    };
    requestedUiSlots: string[];
  };
  error?: string;
}

export interface CapabilityPackageInstallResult {
  id: string;
  packageId?: string;
  pluginRunId?: string;
  mode?: PluginActivationMode;
  version: string;
  toolNames: string[];
  surface: 'tools' | 'internal-feature' | 'ui';
  replacedVersion?: string;
}

export type CapabilityPackageResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; cancelled?: boolean };
