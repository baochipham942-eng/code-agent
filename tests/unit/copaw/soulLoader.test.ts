// ============================================================================
// Soul Loader Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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

// Mock identity
vi.mock('../../../src/main/generation/prompts/identity', () => ({
  IDENTITY_PROMPT: 'DEFAULT_IDENTITY',
}));

describe('SoulLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by re-importing
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return IDENTITY_PROMPT when no files exist', async () => {
    (fs.existsSync as any).mockReturnValue(false);

    const { loadSoul } = await import('../../../src/main/generation/prompts/soulLoader');
    const result = loadSoul('/project');

    expect(result).toBe('DEFAULT_IDENTITY');
  });

  it('should load project PROFILE.md when it exists', async () => {
    (fs.existsSync as any).mockImplementation((p: string) =>
      p === '/project/.code-agent/PROFILE.md'
    );
    (fs.readFileSync as any).mockReturnValue('I am a custom agent');

    const { loadSoul } = await import('../../../src/main/generation/prompts/soulLoader');
    const result = loadSoul('/project');

    expect(result).toBe('I am a custom agent');
  });

  it('should load user SOUL.md when no project PROFILE exists', async () => {
    (fs.existsSync as any).mockImplementation((p: string) =>
      p === '/home/user/.code-agent/SOUL.md'
    );
    (fs.readFileSync as any).mockReturnValue('I am user soul');

    const { loadSoul } = await import('../../../src/main/generation/prompts/soulLoader');
    const result = loadSoul('/project');

    expect(result).toBe('I am user soul');
  });

  it('should prioritize project PROFILE over user SOUL', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('PROFILE.md')) return 'project personality';
      if (p.includes('SOUL.md')) return 'user personality';
      return '';
    });

    const { loadSoul } = await import('../../../src/main/generation/prompts/soulLoader');
    const result = loadSoul('/project');

    expect(result).toBe('project personality');
  });

  it('should cache soul after first load', async () => {
    (fs.existsSync as any).mockReturnValue(false);

    const { loadSoul, getSoul } = await import('../../../src/main/generation/prompts/soulLoader');
    loadSoul('/project');

    // getSoul should return cached value without re-reading
    const result = getSoul();
    expect(result).toBe('DEFAULT_IDENTITY');
  });

  it('should skip empty files', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('   ');

    const { loadSoul } = await import('../../../src/main/generation/prompts/soulLoader');
    const result = loadSoul('/project');

    // Empty/whitespace-only file should fall through to default
    expect(result).toBe('DEFAULT_IDENTITY');
  });

  it('should setup watchers for soul files', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue('soul content');

    const { watchSoulFiles, unwatchSoulFiles } = await import('../../../src/main/generation/prompts/soulLoader');
    watchSoulFiles('/project');

    expect(fs.watch).toHaveBeenCalled();

    unwatchSoulFiles();
  });
});
