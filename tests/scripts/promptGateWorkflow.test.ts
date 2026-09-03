import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW_PATH = '.github/workflows/prompt-gate-evidence.yml';

function workflow(): Record<string, unknown> {
  return parse(fs.readFileSync(path.join(REPO_ROOT, WORKFLOW_PATH), 'utf8')) as Record<string, unknown>;
}

describe('prompt gate evidence workflow', () => {
  it('uses identical PR/push path filters for every prompt evidence input', () => {
    const value = workflow();
    const triggers = (value.on ?? value['on']) as Record<string, { paths?: string[] }>;
    const pullRequest = triggers.pull_request?.paths ?? [];
    const push = triggers.push?.paths ?? [];
    expect(push).toEqual(pullRequest);
    expect(pullRequest).toEqual(expect.arrayContaining([
      'src/host/prompts/**',
      '**/*.schema.ts',
      'src/shared/constants/agent.ts',
      'docs/eval/prompt-gate-latest.json',
    ]));
    expect(pullRequest).not.toContain('docs/**');
  });

  it('runs only static contracts and has the matching gates:local slot', () => {
    const workflowSource = fs.readFileSync(path.join(REPO_ROOT, WORKFLOW_PATH), 'utf8');
    const localSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/gates-local.mjs'), 'utf8');
    expect(workflowSource).toContain('scripts/check-prompt-gate-evidence.ts --base-ref');
    expect(workflowSource).not.toContain('eval:prompt-gate');
    expect(workflowSource).not.toContain('--real');
    expect(localSource).toContain('prompt-gate-evidence / prompt-evidence / Verify fresh prompt evaluation evidence');
    expect(localSource).toContain("scripts/check-prompt-gate-evidence.ts', '--base-ref'");
  });

  it('keeps full release bootstrap disabled until the first paid evidence is committed', () => {
    const registrySource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/releaseEvidenceRegistry.ts'), 'utf8');
    const releaseSource = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(registrySource).toContain('bootstrapped: false');
    expect(releaseSource).not.toContain('docs/eval/prompt-gate-latest.json');
  });
});
