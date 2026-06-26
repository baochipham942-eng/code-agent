import {
  ARTIFACT_PREVIEW_VISION,
  type ArtifactPreviewVisionFindingCode,
} from '../../../../shared/constants/previewHealth';
import type { VisionAnalysisResult } from '../../../services/desktop/visionAnalysisService';

export type ArtifactPreviewVisionSeverity = 'low' | 'medium' | 'high';

export interface ArtifactPreviewVisionFinding {
  code: ArtifactPreviewVisionFindingCode;
  severity: ArtifactPreviewVisionSeverity;
  message: string;
  evidence?: string;
  confidence: number;
}

export interface ArtifactPreviewVisionScreenshot {
  imagePath: string;
  viewport?: string;
  role?: string;
}

export interface ArtifactPreviewVisionInput {
  screenshots: readonly ArtifactPreviewVisionScreenshot[];
  artifactLabel?: string;
  brandRefs?: readonly string[];
}

export interface ArtifactPreviewVisionSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  findings: ArtifactPreviewVisionFinding[];
  failures: string[];
  checks: string[];
  diagnostics: {
    analyzedScreenshots: number;
    skippedScreenshots: number;
    models: string[];
    rawAnalyses: string[];
  };
}

export type ArtifactPreviewVisionAnalyzer = (args: {
  imagePath: string;
  prompt: string;
  source: string;
  timeoutMs?: number;
}) => Promise<VisionAnalysisResult>;

const SUBJECTIVE_CODES = new Set<string>(ARTIFACT_PREVIEW_VISION.SUBJECTIVE_FINDING_CODES);
const SEVERITIES = new Set<string>(['low', 'medium', 'high']);

export function buildArtifactPreviewVisionPrompt(input: {
  artifactLabel?: string;
  viewport?: string;
  role?: string;
  brandRefs?: readonly string[];
}): string {
  const contextLines = [
    `Artifact: ${input.artifactLabel?.trim() || 'unnamed artifact'}`,
    input.viewport ? `Viewport: ${input.viewport}` : null,
    input.role ? `Screenshot role: ${input.role}` : null,
    input.brandRefs && input.brandRefs.length > 0
      ? `Brand references: ${input.brandRefs.map((ref) => ref.trim()).filter(Boolean).join('; ')}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return [
    'You are the subjective visual QA layer for an Agent Neo artifact preview.',
    'Objective runtime and DOM health has already been handled by deterministic QA. Do not duplicate those checks.',
    'Judge only visual qualities that are not reliable as binary DOM rules: typography, visual hierarchy, element occlusion, and brand consistency.',
    'If the screenshot looks acceptable for those subjective qualities, return an empty findings array.',
    '',
    ...contextLines,
    '',
    'Return only JSON with this shape:',
    '{',
    '  "findings": [',
    '    {',
    '      "code": "typography_issue | hierarchy_issue | occlusion_issue | brand_consistency_issue",',
    '      "severity": "low | medium | high",',
    '      "message": "one concrete issue",',
    '      "evidence": "what in the screenshot supports it",',
    '      "confidence": 0.0',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function parseArtifactPreviewVisionAnalysis(text: string): ArtifactPreviewVisionFinding[] {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];

  return findings
    .map((item): ArtifactPreviewVisionFinding | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const code = typeof record.code === 'string' ? record.code : '';
      if (!SUBJECTIVE_CODES.has(code)) return null;
      const confidence = normalizeConfidence(record.confidence);
      if (confidence < ARTIFACT_PREVIEW_VISION.MIN_CONFIDENCE) return null;
      const severity = typeof record.severity === 'string' && SEVERITIES.has(record.severity)
        ? record.severity as ArtifactPreviewVisionSeverity
        : 'medium';
      const message = typeof record.message === 'string' ? record.message.trim() : '';
      if (!message) return null;
      const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : '';
      return {
        code: code as ArtifactPreviewVisionFindingCode,
        severity,
        message,
        ...(evidence ? { evidence } : {}),
        confidence,
      };
    })
    .filter((item): item is ArtifactPreviewVisionFinding => Boolean(item))
    .slice(0, ARTIFACT_PREVIEW_VISION.MAX_FINDINGS);
}

async function analyzeWithConfiguredVisionService(args: Parameters<ArtifactPreviewVisionAnalyzer>[0]) {
  const { analyzeImageWithVisionDetailed } = await import('../../../services/desktop/visionAnalysisService');
  return analyzeImageWithVisionDetailed(args);
}

export async function runArtifactPreviewVision(
  input: ArtifactPreviewVisionInput,
  analyzer: ArtifactPreviewVisionAnalyzer = analyzeWithConfiguredVisionService,
): Promise<ArtifactPreviewVisionSummary> {
  const findings: ArtifactPreviewVisionFinding[] = [];
  const failures: string[] = [];
  const checks: string[] = [];
  const models: string[] = [];
  const rawAnalyses: string[] = [];
  let analyzedScreenshots = 0;
  let skippedScreenshots = 0;

  for (const screenshot of input.screenshots) {
    const prompt = buildArtifactPreviewVisionPrompt({
      artifactLabel: input.artifactLabel,
      viewport: screenshot.viewport,
      role: screenshot.role,
      brandRefs: input.brandRefs,
    });
    const result = await analyzer({
      imagePath: screenshot.imagePath,
      prompt,
      source: 'artifact_preview_vision',
      timeoutMs: ARTIFACT_PREVIEW_VISION.TIMEOUT_MS,
    });

    if (!result.ok) {
      skippedScreenshots += 1;
      checks.push(`artifact preview vision skipped ${screenshot.viewport || screenshot.imagePath}: ${result.reason}`);
      continue;
    }

    analyzedScreenshots += 1;
    models.push(result.model);
    rawAnalyses.push(result.analysis);
    findings.push(...parseArtifactPreviewVisionAnalysis(result.analysis));
  }

  const cappedFindings = findings.slice(0, ARTIFACT_PREVIEW_VISION.MAX_FINDINGS);
  if (cappedFindings.length > 0) {
    failures.push(...cappedFindings.map((finding) => finding.message));
  } else if (analyzedScreenshots > 0) {
    checks.push('artifact preview vision found no subjective visual issues');
  }

  return {
    attempted: input.screenshots.length > 0,
    skipped: input.screenshots.length === 0 || analyzedScreenshots === 0,
    passed: cappedFindings.length === 0,
    findings: cappedFindings,
    failures,
    checks,
    diagnostics: {
      analyzedScreenshots,
      skippedScreenshots,
      models: [...new Set(models)],
      rawAnalyses,
    },
  };
}
