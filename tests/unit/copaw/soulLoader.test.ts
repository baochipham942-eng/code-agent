// ============================================================================
// Soul Loader Tests
// ============================================================================
// 覆盖分层组合语义（Workstream C）：
//   - 用户级 SOUL.md 替换 IDENTITY 核心块
//   - 项目级 PROFILE.md 作为 <project_profile> 扩展追加
//   - 工程层规则（CONCISENESS / TASK / TOOL / MEMORY）始终保留
//   - 两个文件都不存在时返回内置 IDENTITY_PROMPT
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock configPaths
vi.mock('../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => '/home/user/.code-agent',
  getProjectConfigDir: (dir: string) => `${dir}/.code-agent`,
}));

// Mock identity — 必须导出所有 soulLoader 用到的符号
vi.mock('../../../src/main/prompts/identity', () => ({
  IDENTITY: 'DEFAULT_IDENTITY_CORE',
  IDENTITY_PROMPT: 'DEFAULT_IDENTITY_PROMPT_COMPOSITE',
  CONCISENESS_RULES: 'MOCK_CONCISENESS',
  TASK_GUIDELINES: 'MOCK_TASK',
  TOOL_DISCIPLINE: 'MOCK_TOOL',
  MEMORY_SYSTEM: 'MOCK_MEMORY',
}));

describe('SoulLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns built-in IDENTITY_PROMPT when neither SOUL.md nor PROFILE.md exists', async () => {
    (fs.existsSync as any).mockReturnValue(false);

    const { loadSoul } = await import('../../../src/main/prompts/soulLoader');
    const result = loadSoul('/project');

    // Fast path: entirely use the built-in composite
    expect(result).toBe('DEFAULT_IDENTITY_PROMPT_COMPOSITE');
  });

  it('composes PROFILE.md as project extension while keeping engineering layers', async () => {
    (fs.existsSync as any).mockImplementation((p: string) =>
      p === '/project/.code-agent/PROFILE.md',
    );
    (fs.readFileSync as any).mockReturnValue('I am project-specific context');

    const { loadSoul } = await import('../../../src/main/prompts/soulLoader');
    const result = loadSoul('/project');

    // No SOUL.md → core stays DEFAULT_IDENTITY_CORE
    expect(result).toContain('DEFAULT_IDENTITY_CORE');
    // Engineering layers preserved
    expect(result).toContain('MOCK_CONCISENESS');
    expect(result).toContain('MOCK_TASK');
    expect(result).toContain('MOCK_TOOL');
    expect(result).toContain('MOCK_MEMORY');
    // PROFILE appended in <project_profile> wrapper
    expect(result).toContain('<project_profile>');
    expect(result).toContain('I am project-specific context');
    expect(result).toContain('</project_profile>');
  });

  it('replaces IDENTITY core with user SOUL.md, preserving engineering layers', async () => {
    (fs.existsSync as any).mockImplementation((p: string) =>
      p === '/home/user/.code-agent/SOUL.md',
    );
    (fs.readFileSync as any).mockReturnValue('I am user soul');

    const { loadSoul } = await import('../../../src/main/prompts/soulLoader');
    const result = loadSoul('/project');

    // SOUL content took the place of IDENTITY core
    expect(result).toContain('I am user soul');
    expect(result).not.toContain('DEFAULT_IDENTITY_CORE');
    // Engineering layers STILL injected
    expect(result).toContain('MOCK_CONCISENESS');
    expect(result).toContain('MOCK_TASK');
    expect(result).toContain('MOCK_TOOL');
    expect(result).toContain('MOCK_MEMORY');
    // No PROFILE → no <project_profile>
    expect(result).not.toContain('<project_profile>');
  });

  it('composes SOUL.md + PROFILE.md additively (not priority-based)', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('PROFILE.md')) return 'project personality';
      if (p.includes('SOUL.md')) return 'user personality';
      return '';
    });

    const { loadSoul } = await import('../../../src/main/prompts/soulLoader');
    const result = loadSoul('/project');

    // Both must be present — the new semantics is additive, not priority-based.
    // SOUL replaces IDENTITY core, PROFILE appends as project extension.
    expect(result).toContain('user personality');
    expect(result).toContain('project personality');
    expect(result).toContain('<project_profile>');
    expect(result).not.toContain('DEFAULT_IDENTITY_CORE');
    // Engineering layers still in between
    expect(result).toContain('MOCK_CONCISENESS');
  });

  it('caches composed soul after first load', async () => {
    (fs.existsSync as any).mockReturnValue(false);

    const { loadSoul, getSoul } = await import('../../../src/main/prompts/soulLoader');
    loadSoul('/project');

    // Subsequent getSoul() returns cached value without re-reading
    const result = getSoul();
    expect(result).toBe('DEFAULT_IDENTITY_PROMPT_COMPOSITE');
  });

  it('treats empty / whitespace-only files as absent', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('   ');

    const { loadSoul } = await import('../../../src/main/prompts/soulLoader');
    const result = loadSoul('/project');

    // readFileIfExists returns null on whitespace → fast path (built-in prompt)
    expect(result).toBe('DEFAULT_IDENTITY_PROMPT_COMPOSITE');
  });

  it('sets up watchers for SOUL/PROFILE files', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('soul content');

    const { watchSoulFiles, unwatchSoulFiles } = await import(
      '../../../src/main/prompts/soulLoader'
    );
    watchSoulFiles('/project');

    expect(fs.watch).toHaveBeenCalled();

    unwatchSoulFiles();
  });
});
