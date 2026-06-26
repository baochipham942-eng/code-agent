import { describe, expect, it, vi } from 'vitest';
import {
  buildArtifactPreviewVisionPrompt,
  parseArtifactPreviewVisionAnalysis,
  runArtifactPreviewVision,
  type ArtifactPreviewVisionAnalyzer,
} from '../../../../../src/host/agent/runtime/browser/artifactPreviewVision';

describe('artifactPreviewVision subjective layer', () => {
  it('builds a prompt scoped to subjective visual judgment', () => {
    const prompt = buildArtifactPreviewVisionPrompt({
      artifactLabel: 'checkout prototype',
      viewport: 'mobile',
      brandRefs: ['use brand blue for primary actions'],
    });

    expect(prompt).toContain('typography');
    expect(prompt).toContain('visual hierarchy');
    expect(prompt).toContain('element occlusion');
    expect(prompt).toContain('brand consistency');
    expect(prompt).not.toContain('blank_body_text');
    expect(prompt).not.toContain('horizontal_overflow');
    expect(prompt).not.toContain('console_error');
    expect(prompt).not.toContain('broken_image');
    expect(prompt).not.toContain('missing_main_element');
  });

  it('parses subjective findings and drops objective or low-confidence model noise', () => {
    const findings = parseArtifactPreviewVisionAnalysis(`\`\`\`json
{
  "findings": [
    {
      "code": "hierarchy_issue",
      "severity": "high",
      "message": "Primary CTA is visually weaker than secondary actions.",
      "evidence": "Both buttons have the same weight and color.",
      "confidence": 0.88
    },
    {
      "code": "blank_body_text",
      "severity": "high",
      "message": "Objective duplicate that belongs to deterministic QA.",
      "confidence": 0.99
    },
    {
      "code": "typography_issue",
      "severity": "low",
      "message": "Weak signal should be filtered.",
      "confidence": 0.2
    }
  ]
}
\`\`\``);

    expect(findings).toEqual([
      {
        code: 'hierarchy_issue',
        severity: 'high',
        message: 'Primary CTA is visually weaker than secondary actions.',
        evidence: 'Both buttons have the same weight and color.',
        confidence: 0.88,
      },
    ]);
  });

  it('runs the injected vision analyzer and reports subjective bad design issues', async () => {
    const analyzer = vi.fn<ArtifactPreviewVisionAnalyzer>(async ({ imagePath }) => ({
      ok: true,
      analysis: imagePath.includes('bad')
        ? JSON.stringify({
          findings: [
            {
              code: 'occlusion_issue',
              severity: 'high',
              message: 'The floating toolbar covers the form label.',
              evidence: 'The toolbar overlaps the upper-left input label.',
              confidence: 0.91,
            },
            {
              code: 'brand_consistency_issue',
              severity: 'medium',
              message: 'Primary action color does not match the supplied brand reference.',
              evidence: 'CTA is red while the brand reference asks for blue.',
              confidence: 0.84,
            },
          ],
        })
        : JSON.stringify({ findings: [] }),
      model: 'mock-vision',
      originalWidth: 800,
      originalHeight: 600,
      analyzedWidth: 800,
      analyzedHeight: 600,
    }));

    const bad = await runArtifactPreviewVision({
      artifactLabel: 'bad checkout',
      screenshots: [{ imagePath: '/tmp/bad.png', viewport: 'mobile' }],
      brandRefs: ['Primary actions use brand blue.'],
    }, analyzer);
    const good = await runArtifactPreviewVision({
      artifactLabel: 'good checkout',
      screenshots: [{ imagePath: '/tmp/good.png', viewport: 'mobile' }],
      brandRefs: ['Primary actions use brand blue.'],
    }, analyzer);

    expect(bad.passed).toBe(false);
    expect(bad.findings.map((finding) => finding.code)).toEqual([
      'occlusion_issue',
      'brand_consistency_issue',
    ]);
    expect(good.passed).toBe(true);
    expect(good.findings).toEqual([]);
    expect(analyzer).toHaveBeenCalledWith(expect.objectContaining({
      source: 'artifact_preview_vision',
      timeoutMs: expect.any(Number),
    }));
  });
});
