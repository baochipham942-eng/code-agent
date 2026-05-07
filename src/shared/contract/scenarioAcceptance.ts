import type { WorkspacePreviewKind } from './workspacePreview';
import type { PreviewFeedbackItem } from './previewFeedback';
import type { ReviewQueueItem } from './reviewQueue';

export type ScenarioAcceptanceSkillId =
  | 'frontend_ui'
  | 'admin_console'
  | 'document_report'
  | 'research_evidence'
  | 'deployment_share'
  | 'game_generation';

export type ScenarioAcceptanceStatus = 'pass' | 'needs_work' | 'blocked';

export type ScenarioAcceptanceSeverity = 'error' | 'warning';

export type ScenarioAcceptanceAnchorKind =
  | 'artifact'
  | 'file_line'
  | 'html_selector'
  | 'diff_hunk'
  | 'text_quote';

export interface ScenarioAcceptanceAnchor {
  kind: ScenarioAcceptanceAnchorKind;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  selector?: string;
  quote?: string;
  hunk?: string;
}

export interface ScenarioAcceptanceArtifact {
  id: string;
  kind: WorkspacePreviewKind | 'game_artifact';
  title: string;
  filePath?: string;
  content?: {
    text?: string;
    html?: string;
    json?: string;
    diff?: string;
    summary?: string;
  };
  currentTurn?: boolean;
}

export interface ScenarioAcceptanceIssue {
  id: string;
  skillId: ScenarioAcceptanceSkillId;
  artifactId: string;
  code: string;
  severity: ScenarioAcceptanceSeverity;
  title: string;
  message: string;
  evidence: string[];
  repairInstruction: string;
  anchor: ScenarioAcceptanceAnchor;
}

export interface ScenarioAcceptanceCheck {
  id: string;
  skillId: ScenarioAcceptanceSkillId;
  artifactId?: string;
  label: string;
  passed: boolean;
  message?: string;
}

export interface ScenarioAcceptanceSkill {
  id: ScenarioAcceptanceSkillId;
  title: string;
  description: string;
  appliesTo: Array<WorkspacePreviewKind | 'game_artifact'>;
  issueCodes: string[];
  reviewDimensions: string[];
  promptSnippet: string;
}

export interface RunScenarioAcceptanceInput {
  sessionId?: string;
  artifacts: ScenarioAcceptanceArtifact[];
  selectedSkillIds?: ScenarioAcceptanceSkillId[];
  enqueueOnNeedsWork?: boolean;
  createPreviewFeedback?: boolean;
}

export interface ScenarioAcceptanceResult {
  id: string;
  status: ScenarioAcceptanceStatus;
  score: number;
  summary: string;
  skills: ScenarioAcceptanceSkill[];
  issues: ScenarioAcceptanceIssue[];
  checks: ScenarioAcceptanceCheck[];
  createdAt: number;
}

export interface DeliveryReviewMetadata {
  reviewId: string;
  status: ScenarioAcceptanceStatus;
  score: number;
  summary: string;
  skillIds: ScenarioAcceptanceSkillId[];
  issueCount: number;
  issueCodes: string[];
}

export interface RunDeliveryReviewInput extends RunScenarioAcceptanceInput {
  sessionId: string;
  sessionTitle?: string;
}

export interface DeliveryReviewRunResult extends ScenarioAcceptanceResult {
  reviewQueueItem?: ReviewQueueItem;
  previewFeedbackItems?: PreviewFeedbackItem[];
}

export function buildDeliveryReviewMetadata(
  result: ScenarioAcceptanceResult,
): DeliveryReviewMetadata {
  return {
    reviewId: result.id,
    status: result.status,
    score: result.score,
    summary: result.summary,
    skillIds: result.skills.map((skill) => skill.id),
    issueCount: result.issues.length,
    issueCodes: [...new Set(result.issues.map((issue) => issue.code))],
  };
}
