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

  // 2026-09-03 首份付费证据已提交：这条原来钉的是「bootstrap 前」的过渡态（registry false、release 不冻结），
  // 它自己的名字就写明了失效条件；现在钉现行合同——三样必须同时在：证据文件、registry true、release 冻结。
  it('keeps full release bootstrap enabled once the first paid evidence is committed', () => {
    const registrySource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/releaseEvidenceRegistry.ts'), 'utf8');
    const releaseSource = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(fs.existsSync(path.join(REPO_ROOT, 'docs/eval/prompt-gate-latest.json'))).toBe(true);
    expect(registrySource).toContain('bootstrapped: true');
    expect(registrySource).not.toContain('bootstrapped: false');
    expect(releaseSource).toContain('docs/eval/prompt-gate-latest.json');
  });
});
