// ============================================================================
// Deliverable Contract
// ============================================================================

export type DeliverableEvidenceStatus = 'unverified' | 'verified' | 'failed';

export type DeliverableEvidenceKind =
  | 'workspace_status'
  | 'preview_route'
  | 'file_metadata'
  | 'hash'
  | 'artifact_version'
  | 'tool_result'
  | 'validation'
  | 'artifact_issue'
  | 'quality_report';

export interface DeliverableEvidenceRef {
  id: string;
  kind: DeliverableEvidenceKind;
  status: 'pass' | 'fail' | 'metadata';
  summary: string;
  ref?: string;
}

export interface DeliverableEvidencePack {
  status: DeliverableEvidenceStatus;
  summary: string;
  refs: DeliverableEvidenceRef[];
}

export interface DeliverableContextPack {
  goal?: string;
  deliverableType: string;
  sourceOfTruth: string[];
  constraints: string[];
  priorArtifacts: string[];
  acceptance: string[];
  riskNotes: string[];
}

export interface DeliverableContract {
  purpose: string;
  expectedOutput: string;
  inputRefs: string[];
  requiredChecks: string[];
}

export interface DeliverableRevisionContext {
  artifactId: string;
  version?: number;
  parentId?: string;
  parentRef?: string;
  filePath?: string;
  sha256?: string;
  sourceTool?: string;
  changeSummary?: string;
}

export type DeliverableOpenTarget =
  | { kind: 'workspace-preview'; itemId: string }
  | { kind: 'file-preview'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'none'; reason: string };

export type DeliverableCardTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export type DeliverableQualityStatus = 'passed' | 'needs_review' | 'failed' | 'degraded' | 'unknown';

export interface DeliverableQualitySummary {
  status: DeliverableQualityStatus;
  summary: string;
  issueCount?: number;
  blocking?: boolean;
}

export interface DeliverableBundleFileRef {
  path: string;
  name?: string;
  role?: string;
  mimeType?: string;
  sha256?: string;
}

export type DeliverableSecondaryAction =
  | { kind: 'reveal-file'; label: string; path: string; disabled?: boolean; reason?: string }
  | { kind: 'open-file'; label: string; path: string; disabled?: boolean; reason?: string }
  | { kind: 'copy-reference'; label: string; value: string; disabled?: boolean; reason?: string }
  | { kind: 'download-url'; label: string; url: string; filename?: string; disabled?: boolean; reason?: string }
  | {
    kind: 'export-bundle';
    label: string;
    files: DeliverableBundleFileRef[];
    bundleName?: string;
    manifest?: Record<string, unknown>;
    disabled?: boolean;
    reason?: string;
  }
  | {
    /** Batch 2 L3：归档到当前项目资料库（默认打「定稿」标签） */
    kind: 'archive-to-library';
    label: string;
    path: string;
    title: string;
    disabled?: boolean;
    reason?: string;
  };

export interface DeliverableCardView {
  id: string;
  kind: string;
  title: string;
  description: string;
  sourceLabel: string;
  status: DeliverableEvidenceStatus;
  createdAt?: number;
  openTarget: DeliverableOpenTarget;
  contextPack: DeliverableContextPack;
  contract: DeliverableContract;
  evidencePack: DeliverableEvidencePack;
  revisionContext?: DeliverableRevisionContext;
  quality?: DeliverableQualitySummary;
  secondaryActions?: DeliverableSecondaryAction[];
  tone?: DeliverableCardTone;
}
