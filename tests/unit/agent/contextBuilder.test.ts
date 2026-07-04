import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  injectWorkingDirectoryContext,
  buildGitStatusBlock,
  resetGitContextCache,
  resetEnvironmentBlockCache,
} from '../../../src/host/agent/messageHandling/contextBuilder';

describe('injectWorkingDirectoryContext', () => {
  it('clarifies that cwd is not the boundary for machine-level local tasks', () => {
    const prompt = injectWorkingDirectoryContext('BASE', process.cwd(), true);

    expect(prompt).toContain('Working Directory Boundary');
    expect(prompt).toContain('not as the full boundary of the user');
    expect(prompt).toContain('local disk, caches, downloads');
    expect(prompt).toContain('continue from the already established task scope');
    expect(prompt).toContain('unless the user actually wrote it');
  });
});

// ============================================================================
// GAP-010 × 前缀稳定：git 分支 / 最近 commit / dirty 状态是轮内易变信息，
// 从 env block（system 稳定前缀）移到 buildGitStatusBlock（动态尾巴）。
// env block 只保留会话内稳定的 "Is directory a git repo" 一行。
// ============================================================================

describe('git status block (GAP-010, dynamic tail)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-gitctx-'));
  const gitDir = path.join(tmpRoot, 'repo');
  const plainDir = path.join(tmpRoot, 'plain');

  const runInRepo = (cmd: string) => execSync(cmd, { cwd: gitDir, stdio: 'pipe' });

  beforeAll(() => {
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(plainDir, { recursive: true });

    runInRepo('git init -b feature/test-branch');
    runInRepo('git config user.email "test@test.local"');
    runInRepo('git config user.name "Test"');
    fs.writeFileSync(path.join(gitDir, 'a.txt'), 'hello');
    runInRepo('git add a.txt');
    runInRepo('git commit -m "feat: first commit for git context"');
    fs.writeFileSync(path.join(gitDir, 'b.txt'), 'world');
    runInRepo('git add b.txt');
    runInRepo('git commit -m "fix: second commit for git context"');
    // 留一个未提交文件制造 dirty 状态
    fs.writeFileSync(path.join(gitDir, 'dirty.txt'), 'uncommitted');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('injects branch, recent commits and dirty state for git repos', () => {
    resetGitContextCache();

    const block = buildGitStatusBlock(gitDir);

    expect(block).toContain('<git_status>');
    expect(block).toContain('Current branch: feature/test-branch');
    expect(block).toContain('Recent commits:');
    expect(block).toContain('fix: second commit for git context');
    expect(block).toContain('feat: first commit for git context');
    expect(block).toMatch(/Working tree: dirty \(\d+ file\(s\) changed\)/);
  });

  it('reports clean working tree when there are no uncommitted changes', () => {
    resetGitContextCache();
    fs.rmSync(path.join(gitDir, 'dirty.txt'));

    const block = buildGitStatusBlock(gitDir);

    expect(block).toContain('Working tree: clean');
    expect(block).not.toContain('Working tree: dirty');
  });

  it('keeps git volatile details out of the system env block, repo flag stays', () => {
    resetGitContextCache();
    resetEnvironmentBlockCache();

    const prompt = injectWorkingDirectoryContext('BASE', gitDir, false);

    expect(prompt).toContain('Is directory a git repo: Yes');
    expect(prompt).not.toContain('Current branch:');
    expect(prompt).not.toContain('Recent commits:');
    expect(prompt).not.toContain('Working tree:');
  });

  it('returns empty block for non-git directories, env block keeps the "No" line', () => {
    resetGitContextCache();
    resetEnvironmentBlockCache();

    expect(buildGitStatusBlock(plainDir)).toBe('');
    const prompt = injectWorkingDirectoryContext('BASE', plainDir, false);
    expect(prompt).toContain('Is directory a git repo: No');
    expect(prompt).not.toContain('Current branch:');
    expect(prompt).not.toContain('Recent commits:');
  });

  it('serves git context from cache within the TTL window', () => {
    resetGitContextCache();
    buildGitStatusBlock(gitDir);

    // TTL 窗口内新增 commit，缓存命中时不应反映出来
    fs.writeFileSync(path.join(gitDir, 'c.txt'), 'new');
    runInRepo('git add c.txt');
    runInRepo('git commit -m "feat: commit inside ttl window"');

    const cached = buildGitStatusBlock(gitDir);
    expect(cached).not.toContain('commit inside ttl window');

    // 清缓存后能看到新 commit
    resetGitContextCache();
    const fresh = buildGitStatusBlock(gitDir);
    expect(fresh).toContain('commit inside ttl window');
  });

  it('freezes the env block per working directory (byte-stable prefix)', () => {
    resetGitContextCache();
    resetEnvironmentBlockCache();

    const first = injectWorkingDirectoryContext('BASE', gitDir, false);
    // 目录状态变化（新增未提交文件）不应影响已冻结的 env block
    fs.writeFileSync(path.join(gitDir, 'freeze.txt'), 'x');
    resetGitContextCache();
    const second = injectWorkingDirectoryContext('BASE', gitDir, false);

    expect(second).toBe(first);
  });
});

// ============================================================================
// CUA 协议块：set_value/type_text 后的验证必须基于独立信号，不能只回读
// 同一元素的 AXValue（同通道写+读会假阳性——参照 argus GBK 剪贴板事故：
// 对称的错误转换让内部回读全程通过，而真实终态已损坏）
// ============================================================================

describe('buildComputerUseBlock — 验证信号独立性', () => {
  it('协议要求 set_value/type_text 后用独立信号验证，禁止只回读同元素 AXValue', async () => {
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    try {
      const { buildComputerUseBlock } = await import(
        '../../../src/host/agent/messageHandling/contextBuilder'
      );
      const block = buildComputerUseBlock();
      expect(block).toContain('independent signal');
      expect(block).toContain('AXValue');
    } finally {
      delete process.env.CODE_AGENT_ENABLE_CUA;
    }
  });
});
