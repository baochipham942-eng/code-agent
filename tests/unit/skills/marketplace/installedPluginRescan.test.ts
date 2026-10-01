// ============================================================================
// installedPluginRescan Tests — 扫描器版本记录 + 过期已启用记录重扫
// （N-SKILL-SCAN-VERSION-RESCAN）
// 覆盖：版本比较、老记录无 scanner 字段视为 version 0、重扫 block 自动禁用、
// 重扫 pass 回写版本、builtin 跳过、enablePlugin 对过期记录先重扫再启用。
// ============================================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userConfigDir: '',
  projectConfigDir: '',
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  reloadSkills: vi.fn(),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
  getProjectConfigDir: () => mocks.projectConfigDir,
  getCommandsDir: (workingDirectory?: string) => ({
    user: `${mocks.userConfigDir}/commands`,
    ...(workingDirectory ? { project: `${mocks.projectConfigDir}/commands` } : {}),
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: mocks.logDebug,
  }),
}));

vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({ reload: mocks.reloadSkills }),
}));

import { SKILL_GUARD_VERSION } from '../../../../src/host/security/skillContentGuard';
import { enablePlugin } from '../../../../src/host/skills/marketplace/installService';
import {
  getInstalledPluginScannerVersion,
  rescanStaleInstalledPlugins,
} from '../../../../src/host/skills/marketplace/installedPluginRescan';
import { SkillContentScanBlockedError } from '../../../../src/host/skills/marketplace/skillInstallContentGuard';
import type {
  InstalledPluginRecord,
  InstalledPluginsFile,
} from '../../../../src/host/skills/marketplace/types';

const SAFE_SKILL = '---\nname: demo\n---\n# demo\n```bash\nnpm run typecheck\n```\n';
const DANGEROUS_SKILL = '---\nname: demo\n---\n# demo\n```bash\nrm -rf /\n```\n';
const OLD_SCANNED_AT = '2026-09-01T00:00:00.000Z';

describe('installed plugin scanner versioning and rescan', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-rescan-'));
    mocks.userConfigDir = path.join(tempRoot, 'user-config');
    mocks.projectConfigDir = path.join(tempRoot, 'project-config');
    mocks.reloadSkills.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function makePluginRoot(pluginDirName: string, skillContent: string): Promise<string> {
    const pluginRoot = path.join(tempRoot, 'plugins', pluginDirName);
    const skillDir = path.join(pluginRoot, 'skills', 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8');
    return pluginRoot;
  }

  function makeRecord(pluginRoot: string, overrides: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
    return {
      plugin: 'demo',
      marketplace: 'trusted-test',
      sourceTrust: 'local-marketplace',
      scope: 'user',
      isEnabled: true,
      installedAt: OLD_SCANNED_AT,
      pluginRoot,
      skills: ['demo'],
      skillPaths: ['skills/demo'],
      sourceMarketplacePath: pluginRoot,
      ...overrides,
    };
  }

  function freshScanner(): NonNullable<InstalledPluginRecord['scanner']> {
    return { version: SKILL_GUARD_VERSION, verdict: 'pass', scannedAt: OLD_SCANNED_AT };
  }

  async function writeState(state: InstalledPluginsFile): Promise<void> {
    await fs.mkdir(mocks.userConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(mocks.userConfigDir, 'installed-plugins.json'),
      JSON.stringify(state, null, 2),
      'utf8',
    );
  }

  async function readState(): Promise<InstalledPluginsFile> {
    const raw = await fs.readFile(path.join(mocks.userConfigDir, 'installed-plugins.json'), 'utf8');
    return JSON.parse(raw) as InstalledPluginsFile;
  }

  it('SKILL_GUARD_VERSION 是大于 0 的整数常量', () => {
    expect(Number.isInteger(SKILL_GUARD_VERSION)).toBe(true);
    expect(SKILL_GUARD_VERSION).toBeGreaterThan(0);
  });

  it('scanner 字段缺失的老记录视为 version 0，有字段按字段值比较', () => {
    const record = makeRecord('/nonexistent');
    expect(getInstalledPluginScannerVersion(record)).toBe(0);
    expect(getInstalledPluginScannerVersion({ ...record, scanner: freshScanner() })).toBe(SKILL_GUARD_VERSION);
  });

  it('版本已新鲜的已启用记录不重扫（盘上危险内容也不触发）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot, { scanner: freshScanner() }) });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 0, blocked: [] });
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(true);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('无 scanner 字段的老已启用记录按 version 0 重扫，pass 回写新版本', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot) });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: [] });
    const record = (await readState())['demo@trusted-test']!;
    expect(record.isEnabled).toBe(true);
    expect(record.scanner?.version).toBe(SKILL_GUARD_VERSION);
    expect(record.scanner?.verdict).toBe('pass');
    expect(Number.isNaN(Date.parse(record.scanner?.scannedAt ?? ''))).toBe(false);
  });

  it('重扫 block → isEnabled=false 并 warn 日志带 pluginSpec 与 finding kinds', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, {
        scanner: { version: SKILL_GUARD_VERSION - 1, verdict: 'pass', scannedAt: OLD_SCANNED_AT },
      }),
    });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: ['demo@trusted-test'] });
    const record = (await readState())['demo@trusted-test']!;
    expect(record.isEnabled).toBe(false);
    const warnCall = mocks.logWarn.mock.calls.find(
      (call) => String(call[0]).includes('rescan'),
    );
    expect(warnCall).toBeDefined();
    const meta = warnCall?.[1] as Record<string, unknown> | undefined;
    expect(meta?.pluginSpec).toBe('demo@trusted-test');
    expect(meta?.findings).toContain('dangerous_command');
  });

  it('builtin 来源跳过重扫（与 scanInstallContent 的 builtin 分支一致）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot, { sourceTrust: 'builtin' }) });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 0, blocked: [] });
    const record = (await readState())['demo@trusted-test']!;
    expect(record.isEnabled).toBe(true);
    expect(record.scanner).toBeUndefined();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('已禁用记录不在启动重扫范围内', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot, { isEnabled: false }) });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 0, blocked: [] });
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(false);
  });

  it('enablePlugin 对过期记录先重扫，block 抛 SkillContentScanBlockedError 而不是静默启用', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot, { isEnabled: false }) });

    const error = await enablePlugin('demo@trusted-test').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SkillContentScanBlockedError);
    expect((error as Error).message).toContain('SKILL_CONTENT_SCAN_BLOCKED');
    const record = (await readState())['demo@trusted-test']!;
    expect(record.isEnabled).toBe(false);
    expect(mocks.reloadSkills).not.toHaveBeenCalled();
  });

  it('enablePlugin 对过期记录重扫 pass 后启用并回写新版本', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot, { isEnabled: false }) });

    await enablePlugin('demo@trusted-test');

    const record = (await readState())['demo@trusted-test']!;
    expect(record.isEnabled).toBe(true);
    expect(record.scanner?.version).toBe(SKILL_GUARD_VERSION);
    expect(record.scanner?.verdict).toBe('pass');
    expect(mocks.reloadSkills).toHaveBeenCalledTimes(1);
  });

  it('enablePlugin 对新鲜记录不重复扫描直接启用（盘上危险内容也不触发）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, { isEnabled: false, scanner: freshScanner() }),
    });

    await enablePlugin('demo@trusted-test');

    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(true);
    expect(mocks.reloadSkills).toHaveBeenCalledTimes(1);
  });
});
