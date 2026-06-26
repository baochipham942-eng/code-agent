import {
  DESIGN_PREVIEW_REPAIR,
  type ArtifactPreviewVisionFindingCode,
} from '../../../../shared/constants/previewHealth';
import {
  formatDesignAcceptanceContractForPrompt,
  normalizeDesignAcceptanceContract,
  type DesignAcceptanceContract,
} from '../../../../shared/contract/designAcceptanceContract';
import {
  runArtifactPreviewHealth,
  type ArtifactPreviewHealthFinding,
  type ArtifactPreviewHealthFindingCode,
  type ArtifactPreviewHealthOptions,
  type ArtifactPreviewHealthSummary,
} from './artifactPreviewHealth';
import {
  runArtifactPreviewVision,
  type ArtifactPreviewVisionAnalyzer,
  type ArtifactPreviewVisionFinding,
  type ArtifactPreviewVisionInput,
  type ArtifactPreviewVisionSummary,
} from './artifactPreviewVision';

export type DesignPreviewRepairSource = 'deterministic' | 'vision';
export type DesignPreviewRepairStateScope = 'ephemeral_loop';

export interface DesignPreviewRepairFinding {
  source: DesignPreviewRepairSource;
  code: ArtifactPreviewHealthFindingCode | ArtifactPreviewVisionFindingCode;
  message: string;
  viewport?: string;
  severity?: ArtifactPreviewVisionFinding['severity'];
  evidence?: ArtifactPreviewHealthFinding['evidence'] | string;
  confidence?: number;
}

export interface DesignPreviewRepairAssessment {
  passed: boolean;
  findings: DesignPreviewRepairFinding[];
  health: ArtifactPreviewHealthSummary;
  vision?: ArtifactPreviewVisionSummary;
}

export interface DesignPreviewRepairSpec {
  version: typeof DESIGN_PREVIEW_REPAIR.VERSION;
  artifactPath: string;
  artifactLabel?: string;
  attempt: number;
  stateScope: DesignPreviewRepairStateScope;
  legacyArtifactRepairGuard: 'not_used';
  acceptanceContract?: DesignAcceptanceContract;
  findings: DesignPreviewRepairFinding[];
  deterministicFindings: ArtifactPreviewHealthFinding[];
  subjectiveFindings: ArtifactPreviewVisionFinding[];
  repairDirectives: string[];
}

export interface DesignPreviewRepairAgentResult {
  success: boolean;
  summary?: string;
  error?: string;
  modifiedFiles?: string[];
}

export type DesignPreviewRepairAgent = (args: {
  artifactPath: string;
  attempt: number;
  assessment: DesignPreviewRepairAssessment;
  spec: DesignPreviewRepairSpec;
  prompt: string;
}) => Promise<DesignPreviewRepairAgentResult>;

export type DesignPreviewHealthRunner = (
  artifactPath: string,
  options?: ArtifactPreviewHealthOptions,
) => Promise<ArtifactPreviewHealthSummary>;

export type DesignPreviewVisionRunner = (
  input: ArtifactPreviewVisionInput,
  analyzer?: ArtifactPreviewVisionAnalyzer,
) => Promise<ArtifactPreviewVisionSummary>;

export interface DesignPreviewRepairOptions {
  artifactLabel?: string;
  acceptanceContract?: unknown;
  healthOptions?: ArtifactPreviewHealthOptions;
  healthRunner?: DesignPreviewHealthRunner;
  visionInput?: ArtifactPreviewVisionInput;
  visionAnalyzer?: ArtifactPreviewVisionAnalyzer;
  visionRunner?: DesignPreviewVisionRunner;
  repairAgent: DesignPreviewRepairAgent;
  maxAttempts?: number;
}

export interface DesignPreviewRepairRound {
  attempt: number;
  assessment: DesignPreviewRepairAssessment;
  repairSpec?: DesignPreviewRepairSpec;
  repairPrompt?: string;
  agentResult?: DesignPreviewRepairAgentResult;
}

export interface DesignPreviewRepairResult {
  passed: boolean;
  artifactPath: string;
  stateScope: DesignPreviewRepairStateScope;
  legacyArtifactRepairGuard: 'not_used';
  repairAttempts: number;
  rounds: DesignPreviewRepairRound[];
  finalAssessment: DesignPreviewRepairAssessment;
  escalationReason?: string;
}

const DETERMINISTIC_REPAIR_DIRECTIVES: Record<ArtifactPreviewHealthFindingCode, string> = {
  blank_body_text: 'Restore visible textual content inside the preview root; do not ask the user to confirm blankness.',
  horizontal_overflow: 'Remove horizontal overflow at every tested viewport with responsive sizing or wrapping.',
  console_error: 'Eliminate console errors at runtime and keep the artifact usable after scripts execute.',
  page_error: 'Fix runtime exceptions before judging visual quality.',
  broken_image: 'Replace missing images with working local, data URI, or reachable assets.',
  missing_main_element: 'Add a visible main artifact root such as main, data-preview-root, or data-design-root.',
  responsive_breakpoint_failure: 'Fix the breakpoint-specific failure without regressing healthy viewports.',
};

const SUBJECTIVE_REPAIR_DIRECTIVES: Record<ArtifactPreviewVisionFindingCode, string> = {
  typography_issue: 'Improve type scale, weight, spacing, and readability while preserving intent.',
  hierarchy_issue: 'Make the primary task, content order, and CTA hierarchy visually clear.',
  occlusion_issue: 'Move or resize overlapping elements so important content and controls remain readable and clickable.',
  brand_consistency_issue: 'Align color, visual language, and brand cues with the supplied brand references.',
};

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 3))}...` : value;
}

function healthFindingToRepairFinding(finding: ArtifactPreviewHealthFinding): DesignPreviewRepairFinding {
  return {
    source: 'deterministic',
    code: finding.code,
    message: finding.message,
    ...(finding.viewport ? { viewport: finding.viewport } : {}),
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
  };
}

function visionFindingToRepairFinding(finding: ArtifactPreviewVisionFinding): DesignPreviewRepairFinding {
  return {
    source: 'vision',
    code: finding.code,
    message: finding.message,
    severity: finding.severity,
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
    confidence: finding.confidence,
  };
}

function buildRepairDirectives(findings: readonly DesignPreviewRepairFinding[]): string[] {
  const directives = findings.map((finding) => {
    if (finding.source === 'deterministic') {
      return DETERMINISTIC_REPAIR_DIRECTIVES[finding.code as ArtifactPreviewHealthFindingCode];
    }
    return SUBJECTIVE_REPAIR_DIRECTIVES[finding.code as ArtifactPreviewVisionFindingCode];
  });
  return [...new Set(directives.filter((directive): directive is string => Boolean(directive)))]
    .slice(0, DESIGN_PREVIEW_REPAIR.MAX_FINDINGS);
}

export async function runDesignPreviewRepairAssessment(
  artifactPath: string,
  options: Omit<DesignPreviewRepairOptions, 'repairAgent' | 'maxAttempts'> = {},
): Promise<DesignPreviewRepairAssessment> {
  const healthRunner = options.healthRunner ?? runArtifactPreviewHealth;
  const visionRunner = options.visionRunner ?? runArtifactPreviewVision;
  const health = await healthRunner(artifactPath, options.healthOptions);
  let vision: ArtifactPreviewVisionSummary | undefined;

  if (options.visionInput?.screenshots.length) {
    vision = await visionRunner({
      ...options.visionInput,
      artifactLabel: options.visionInput.artifactLabel ?? options.artifactLabel,
    }, options.visionAnalyzer);
  }

  const findings = [
    ...health.findings.map(healthFindingToRepairFinding),
    ...(vision?.findings ?? []).map(visionFindingToRepairFinding),
  ].slice(0, DESIGN_PREVIEW_REPAIR.MAX_FINDINGS);

  return {
    passed: health.passed && (vision?.passed ?? true) && findings.length === 0,
    findings,
    health,
    ...(vision ? { vision } : {}),
  };
}

export function createDesignPreviewRepairSpec(args: {
  artifactPath: string;
  artifactLabel?: string;
  attempt: number;
  assessment: DesignPreviewRepairAssessment;
  acceptanceContract?: unknown;
}): DesignPreviewRepairSpec {
  const acceptanceContract = normalizeDesignAcceptanceContract(args.acceptanceContract);
  const spec: DesignPreviewRepairSpec = {
    version: DESIGN_PREVIEW_REPAIR.VERSION,
    artifactPath: args.artifactPath,
    attempt: args.attempt,
    stateScope: 'ephemeral_loop',
    legacyArtifactRepairGuard: 'not_used',
    findings: args.assessment.findings,
    deterministicFindings: args.assessment.health.findings,
    subjectiveFindings: args.assessment.vision?.findings ?? [],
    repairDirectives: buildRepairDirectives(args.assessment.findings),
  };
  if (args.artifactLabel) spec.artifactLabel = args.artifactLabel;
  if (acceptanceContract) spec.acceptanceContract = acceptanceContract;
  return spec;
}

export function formatDesignPreviewRepairSpecForPrompt(spec: DesignPreviewRepairSpec): string {
  const acceptanceContract = formatDesignAcceptanceContractForPrompt(spec.acceptanceContract);
  const payload = {
    ...spec,
    acceptanceContract: spec.acceptanceContract ?? undefined,
  };
  const prompt = [
    '<design-preview-repair-spec>',
    JSON.stringify(payload, null, 2),
    '</design-preview-repair-spec>',
    '',
    'Repair this design artifact in place. Code stays invisible to the user; success is the running artifact passing preview QA and interaction checks.',
    'Use deterministic findings for objective binary failures and vision findings only for subjective visual quality issues.',
    'Do not ask the user to fill fidelity gaps. Preserve locked regions and brand references from the acceptance contract.',
    ...(acceptanceContract
      ? [
          '',
          '<design-acceptance-contract-json>',
          acceptanceContract,
          '</design-acceptance-contract-json>',
        ]
      : []),
  ].join('\n');
  return truncateText(prompt, DESIGN_PREVIEW_REPAIR.MAX_PROMPT_CHARS);
}

export async function runDesignPreviewRepairLoop(
  artifactPath: string,
  options: DesignPreviewRepairOptions,
): Promise<DesignPreviewRepairResult> {
  const maxAttempts = options.maxAttempts ?? DESIGN_PREVIEW_REPAIR.MAX_ATTEMPTS;
  const rounds: DesignPreviewRepairRound[] = [];
  let assessment = await runDesignPreviewRepairAssessment(artifactPath, options);

  rounds.push({
    attempt: 0,
    assessment,
  });

  if (assessment.passed) {
    return {
      passed: true,
      artifactPath,
      stateScope: 'ephemeral_loop',
      legacyArtifactRepairGuard: 'not_used',
      repairAttempts: 0,
      rounds,
      finalAssessment: assessment,
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const spec = createDesignPreviewRepairSpec({
      artifactPath,
      artifactLabel: options.artifactLabel,
      attempt,
      assessment,
      acceptanceContract: options.acceptanceContract,
    });
    const prompt = formatDesignPreviewRepairSpecForPrompt(spec);
    const agentResult = await options.repairAgent({
      artifactPath,
      attempt,
      assessment,
      spec,
      prompt,
    });

    if (!agentResult.success) {
      return {
        passed: false,
        artifactPath,
        stateScope: 'ephemeral_loop',
        legacyArtifactRepairGuard: 'not_used',
        repairAttempts: attempt,
        rounds: [
          ...rounds,
          {
            attempt,
            assessment,
            repairSpec: spec,
            repairPrompt: prompt,
            agentResult,
          },
        ],
        finalAssessment: assessment,
        escalationReason: agentResult.error || 'design preview repair agent failed',
      };
    }

    assessment = await runDesignPreviewRepairAssessment(artifactPath, options);
    rounds.push({
      attempt,
      assessment,
      repairSpec: spec,
      repairPrompt: prompt,
      agentResult,
    });

    if (assessment.passed) {
      return {
        passed: true,
        artifactPath,
        stateScope: 'ephemeral_loop',
        legacyArtifactRepairGuard: 'not_used',
        repairAttempts: attempt,
        rounds,
        finalAssessment: assessment,
      };
    }
  }

  return {
    passed: false,
    artifactPath,
    stateScope: 'ephemeral_loop',
    legacyArtifactRepairGuard: 'not_used',
    repairAttempts: maxAttempts,
    rounds,
    finalAssessment: assessment,
    escalationReason: `design preview repair cap reached: ${maxAttempts}/${maxAttempts}`,
  };
}
