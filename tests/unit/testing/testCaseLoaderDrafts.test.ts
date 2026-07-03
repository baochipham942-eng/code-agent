// ---------------------------------------------------------------------------
// 批 1 回流桥前置契约：正式 loader 只扫目录一层，drafts/ 子目录的草稿
// 默认不进套件（草稿 = 未补断言的弱证据，人工 review 后才移入正式目录）。
// 该行为是现状，此测试把它钉死，防未来 loader 改成递归时静默吸入草稿。
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadAllTestSuites, loadTestSuite } from '../../../src/host/testing/testCaseLoader';

const SUITE_YAML = `
name: normal-suite
cases:
  - id: normal-case
    type: tool
    prompt: list files
`;

const DRAFT_YAML = `
name: draft-suite
cases:
  - id: draft-case
    type: tool
    prompt: 用户原话
    sourceSessionId: web-session-123
    reviewStatus: pending
`;

describe('testCaseLoader drafts 隔离', () => {
  it('loadAllTestSuites 不加载 drafts/ 子目录', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'case-loader-drafts-'));
    await writeFile(path.join(dir, 'suite.yaml'), SUITE_YAML);
    await mkdir(path.join(dir, 'drafts'));
    await writeFile(path.join(dir, 'drafts', 'draft.yaml'), DRAFT_YAML);

    const suites = await loadAllTestSuites(dir);
    const names = suites.map((s) => s.name);
    expect(names).toContain('normal-suite');
    expect(names).not.toContain('draft-suite');
  });

  it('草稿显式加载时 sourceSessionId/reviewStatus 直通进 TestCase', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'case-loader-draft-fields-'));
    const draftPath = path.join(dir, 'draft.yaml');
    await writeFile(draftPath, DRAFT_YAML);

    const suite = await loadTestSuite(draftPath);
    expect(suite.cases[0].sourceSessionId).toBe('web-session-123');
    expect(suite.cases[0].reviewStatus).toBe('pending');
  });
});
