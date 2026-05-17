export type ConfigScopeLayerId = 'user' | 'project' | 'local' | 'runtime';

export type ConfigScopeItemKind = 'file' | 'directory' | 'runtime';

export type ConfigScopeItemStatus = 'active' | 'present' | 'missing' | 'warning';

export type ConfigShareability = 'private' | 'team-shareable' | 'local-only' | 'runtime-private';

export type ConfigSafetySeverity = 'info' | 'warning' | 'critical';

export type ConfigSafetyRiskKind =
  | 'absolute_path'
  | 'secret'
  | 'private_endpoint'
  | 'dangerous_shell'
  | 'hooks_location';

export type ConfigSafetyScanStatus = 'clear' | 'needs_review' | 'no_workspace';

export interface ConfigScopeItem {
  id: string;
  label: string;
  description: string;
  path: string;
  kind: ConfigScopeItemKind;
  exists: boolean;
  active: boolean;
  private: boolean;
  status: ConfigScopeItemStatus;
  detail?: string;
  warning?: string;
}

export interface ConfigScopeLayer {
  id: ConfigScopeLayerId;
  label: string;
  description: string;
  pathLabel: string;
  items: ConfigScopeItem[];
  presentCount: number;
  activeCount: number;
  warningCount: number;
}

export interface ConfigWriteRecommendation {
  id: string;
  label: string;
  description: string;
  recommendedLayer: ConfigScopeLayerId;
  shareability: ConfigShareability;
  teamShareable: boolean;
  guidance: string;
}

export interface ConfigSafetyScanTarget {
  id: string;
  label: string;
  path: string;
  relativePath: string;
  kind: 'file' | 'directory';
  exists: boolean;
  scannedFiles: number;
}

export interface ConfigSafetyScanFinding {
  id: string;
  kind: ConfigSafetyRiskKind;
  severity: ConfigSafetySeverity;
  label: string;
  target: string;
  targetLabel: string;
  locations: string[];
  detail: string;
  recommendation: string;
}

export interface ConfigSafetyScanSummary {
  status: ConfigSafetyScanStatus;
  scannedAt: number;
  workingDirectory: string | null;
  totalFindings: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  targets: ConfigSafetyScanTarget[];
  findings: ConfigSafetyScanFinding[];
}

export interface ConfigScopeSummary {
  workingDirectory: string | null;
  generatedAt: number;
  layers: ConfigScopeLayer[];
  writeRecommendations: ConfigWriteRecommendation[];
  safetyScan: ConfigSafetyScanSummary;
}
