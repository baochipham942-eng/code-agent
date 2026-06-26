import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { getUserConfigDir } from '../../../../../src/main/config/configPaths';
import {
  isDesignDraftWorkingDir,
  seedArtifactRepairGuardFromContext,
} from '../../../../../src/main/agent/runtime/artifactRepairGuard';
import type { RuntimeContext } from '../../../../../src/main/agent/runtime/runtimeContext';
import type {
  ArtifactPreviewHealthSummary,
} from '../../../../../src/main/agent/runtime/browser/artifactPreviewHealth';
import type {
  ArtifactPreviewVisionSummary,
} from '../../../../../src/main/agent/runtime/browser/artifactPreviewVision';
import {
  createDesignPreviewRepairSpec,
  runDesignPreviewRepairLoop,
  type DesignPreviewHealthRunner,
  type DesignPreviewRepairAgent,
  type DesignPreviewVisionRunner,
} from '../../../../../src/main/agent/runtime/browser/designPreviewRepair';

function healthSummary(overrides: Partial<ArtifactPreviewHealthSummary> = {}): ArtifactPreviewHealthSummary {
  return {
    attempted: true,
    passed: true,
    findings: [],
    failures: [],
    checks: [],
    ...overrides,
  };
}

function visionSummary(overrides: Partial<ArtifactPreviewVisionSummary> = {}): ArtifactPreviewVisionSummary {
  return {
    attempted: true,
    passed: true,
    findings: [],
    failures: [],
    checks: [],
    diagnostics: {
      analyzedScreenshots: 1,
      skippedScreenshots: 0,
      models: ['mock-vision'],
      rawAnalyses: [],
    },
    ...overrides,
  };
}

describe('designPreviewRepair', () => {
  it('builds a design repair spec from deterministic and subjective preview QA findings', () => {
    const assessment = {
      passed: false,
      findings: [
        {
          source: 'deterministic' as const,
          code: 'horizontal_overflow' as const,
          message: 'mobile preview overflows horizontally.',
          viewport: 'mobile',
        },
        {
          source: 'vision' as const,
          code: 'occlusion_issue' as const,
          message: 'Toolbar covers the primary CTA.',
          severity: 'high' as const,
          evidence: 'CTA is partially hidden.',
          confidence: 0.91,
        },
      ],
      health: healthSummary({
        passed: false,
        findings: [
          {
            code: 'horizontal_overflow',
            message: 'mobile preview overflows horizontally.',
            viewport: 'mobile',
          },
        ],
        failures: ['mobile preview overflows horizontally.'],
      }),
      vision: visionSummary({
        passed: false,
        findings: [
          {
            code: 'occlusion_issue',
            severity: 'high',
            message: 'Toolbar covers the primary CTA.',
            evidence: 'CTA is partially hidden.',
            confidence: 0.91,
          },
        ],
        failures: ['Toolbar covers the primary CTA.'],
      }),
    };

    const spec = createDesignPreviewRepairSpec({
      artifactPath: '/tmp/bad-design.html',
      artifactLabel: 'interactive checkout',
      attempt: 1,
      assessment,
      acceptanceContract: {
        acceptanceCriteria: ['CTA remains clickable after repair.'],
        lockedRegions: [
          {
            nodeId: 'header',
            preserve: ['layout'],
            lockMode: 'strict',
          },
        ],
        brandRefs: [
          {
            name: 'Neo',
            source: 'manual',
            notes: ['Use brand blue for primary actions.'],
          },
        ],
      },
    });

    expect(spec).toMatchObject({
      artifactPath: '/tmp/bad-design.html',
      artifactLabel: 'interactive checkout',
      stateScope: 'ephemeral_loop',
      legacyArtifactRepairGuard: 'not_used',
    });
    expect(spec.deterministicFindings.map((finding) => finding.code)).toEqual(['horizontal_overflow']);
    expect(spec.subjectiveFindings.map((finding) => finding.code)).toEqual(['occlusion_issue']);
    expect(spec.repairDirectives.join('\n')).toContain('Remove horizontal overflow');
    expect(spec.repairDirectives.join('\n')).toContain('overlapping elements');
    expect(spec.acceptanceContract?.lockedRegions[0]?.regionLock.strict).toBe(true);
  });

  it('feeds QA findings to the repair agent and revalidates the repaired artifact', async () => {
    const failedHealth = healthSummary({
      passed: false,
      findings: [
        {
          code: 'broken_image',
          message: 'desktop preview contains broken image(s).',
          viewport: 'desktop',
        },
      ],
      failures: ['desktop preview contains broken image(s).'],
    });
    const passedHealth = healthSummary();
    const failedVision = visionSummary({
      passed: false,
      findings: [
        {
          code: 'hierarchy_issue',
          severity: 'medium',
          message: 'Primary action is visually weaker than secondary content.',
          evidence: 'CTA has low contrast.',
          confidence: 0.78,
        },
      ],
      failures: ['Primary action is visually weaker than secondary content.'],
    });
    const passedVision = visionSummary();

    const healthRunner = vi.fn<DesignPreviewHealthRunner>()
      .mockResolvedValueOnce(failedHealth)
      .mockResolvedValueOnce(passedHealth);
    const visionRunner = vi.fn<DesignPreviewVisionRunner>()
      .mockResolvedValueOnce(failedVision)
      .mockResolvedValueOnce(passedVision);
    const repairAgent = vi.fn<DesignPreviewRepairAgent>(async ({ spec, prompt }) => {
      expect(spec.stateScope).toBe('ephemeral_loop');
      expect(spec.legacyArtifactRepairGuard).toBe('not_used');
      expect(spec.findings.map((finding) => finding.code)).toEqual(['broken_image', 'hierarchy_issue']);
      expect(prompt).toContain('<design-preview-repair-spec>');
      expect(prompt).toContain('Code stays invisible to the user');
      return {
        success: true,
        summary: 'Repaired preview markup and hierarchy.',
        modifiedFiles: ['/tmp/bad-design.html'],
      };
    });

    const result = await runDesignPreviewRepairLoop('/tmp/bad-design.html', {
      artifactLabel: 'checkout prototype',
      healthRunner,
      visionRunner,
      visionInput: {
        screenshots: [{ imagePath: '/tmp/bad-design.png', viewport: 'mobile' }],
      },
      repairAgent,
      maxAttempts: 1,
    });

    expect(result.passed).toBe(true);
    expect(result.repairAttempts).toBe(1);
    expect(result.stateScope).toBe('ephemeral_loop');
    expect(result.legacyArtifactRepairGuard).toBe('not_used');
    expect(result.rounds).toHaveLength(2);
    expect(healthRunner).toHaveBeenCalledTimes(2);
    expect(visionRunner).toHaveBeenCalledTimes(2);
    expect(repairAgent).toHaveBeenCalledTimes(1);
  });

  it('caps design repair attempts without entering the legacy artifactRepairGuard state machine', async () => {
    const failedHealth = healthSummary({
      passed: false,
      findings: [
        {
          code: 'missing_main_element',
          message: 'desktop preview is missing a visible main artifact element.',
          viewport: 'desktop',
        },
      ],
      failures: ['desktop preview is missing a visible main artifact element.'],
    });
    const healthRunner = vi.fn<DesignPreviewHealthRunner>().mockResolvedValue(failedHealth);
    const repairAgent = vi.fn<DesignPreviewRepairAgent>(async () => ({ success: true }));

    const result = await runDesignPreviewRepairLoop('/tmp/still-bad.html', {
      healthRunner,
      repairAgent,
      maxAttempts: 1,
    });

    expect(result.passed).toBe(false);
    expect(result.repairAttempts).toBe(1);
    expect(result.escalationReason).toContain('design preview repair cap reached');
    expect(result.legacyArtifactRepairGuard).toBe('not_used');
    expect(repairAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps stale legacy artifact repair guard cleared for design draft working dirs', () => {
    const designWorkingDir = join(getUserConfigDir(), 'design', 'stage5-session');
    expect(isDesignDraftWorkingDir(designWorkingDir)).toBe(true);

    const ctx = {
      workingDirectory: designWorkingDir,
      artifactRepairGuard: {
        targetFile: '/tmp/stale-game.html',
        attempts: 3,
        phase: 'targeted_repair',
        patched: false,
      },
      messages: [
        {
          role: 'system',
          content: 'Artifact validation failed for /tmp/stale-game.html. repair target file: /tmp/stale-game.html',
        },
      ],
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">target file: /tmp/stale-game.html</artifact-validation-failed>',
      ],
    } as unknown as RuntimeContext;

    seedArtifactRepairGuardFromContext(ctx);

    expect(ctx.artifactRepairGuard).toBeUndefined();
  });
});
