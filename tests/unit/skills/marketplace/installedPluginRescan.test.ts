// ============================================================================
// installedPluginRescan Tests — 扫描器版本记录 + 过期已启用记录重扫
// （N-SKILL-SCAN-VERSION-RESCAN）
// 覆盖：版本比较、老记录无 scanner 字段视为 version 0、重扫 block 自动禁用、
// 重扫 pass 回写版本、builtin 跳过、enablePlugin 对过期记录先重扫再启用。
// ============================================================================

import fs from 'fs/promises';
import fsSync from 'fs';
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

// 部分 mock：scanPluginRootContent 包一层 duringScan 钩子，用来在重扫的扫描期
// 注入并发操作（禁用/新增安装/重装），钉死「读快照→扫描→写回」不覆盖并发变更。
const scanHooks = vi.hoisted(() => ({
  duringScan: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../../../../src/host/skills/marketplace/skillInstallContentGuard', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/host/skills/marketplace/skillInstallContentGuard')>();
  return {
    ...actual,
    scanPluginRootContent: async (args: Parameters<typeof actual.scanPluginRootContent>[0]) => {
      await scanHooks.duringScan?.();
      return actual.scanPluginRootContent(args);
    },
  };
});

import { SKILL_GUARD_VERSION } from '../../../../src/host/security/skillContentGuard';
import {
  deactivatePluginCommands,
  disablePlugin,
  enablePlugin,
  loadInstalledPlugins,
  saveInstalledPlugins,
} from '../../../../src/host/skills/marketplace/installService';
import {
  getInstalledPluginsStateVersion,
  saveInstalledPluginsIfVersionUnchanged,
} from '../../../../src/host/skills/marketplace/installedPluginsStateStore';
import {
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
    scanHooks.duringScan = undefined;
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

  it('scanner.version 显式为 0 的记录同样按过期重扫（与缺字段等价，可观察行为口径）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, {
        scanner: { version: 0, verdict: 'pass', scannedAt: OLD_SCANNED_AT },
      }),
    });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: ['demo@trusted-test'] });
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(false);
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

  it('重扫扫描期并发 disablePlugin 的 isEnabled=false 不被旧快照覆盖', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot) });
    scanHooks.duringScan = async () => {
      await disablePlugin('demo@trusted-test');
    };

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: [] });
    const record = (await readState())['demo@trusted-test']!;
    expect(record.isEnabled).toBe(false);
    // pass 结论仍合写到未被替换的记录上
    expect(record.scanner?.version).toBe(SKILL_GUARD_VERSION);
  });

  it('重扫扫描期并发新增的安装记录不丢失', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot) });
    scanHooks.duringScan = async () => {
      const state = await readState();
      state['other@trusted-test'] = makeRecord('/nonexistent-other', { isEnabled: false });
      await writeState(state);
    };

    await rescanStaleInstalledPlugins();

    const state = await readState();
    expect(state['other@trusted-test']).toBeDefined();
    expect(state['demo@trusted-test']!.scanner?.version).toBe(SKILL_GUARD_VERSION);
  });

  it('重扫扫描期记录被替换（重装）→ 扫描结论跳过不回写', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot) });
    scanHooks.duringScan = async () => {
      const state = await readState();
      state['demo@trusted-test'] = makeRecord(pluginRoot, { installedAt: '2026-09-30T00:00:00.000Z' });
      await writeState(state);
    };

    const summary = await rescanStaleInstalledPlugins();

    expect(summary.rescanned).toBe(1);
    const record = (await readState())['demo@trusted-test']!;
    expect(record.installedAt).toBe('2026-09-30T00:00:00.000Z');
    expect(record.scanner).toBeUndefined();
    expect(
      mocks.logWarn.mock.calls.some((call) => String(call[0]).includes('changed during rescan')),
    ).toBe(true);
  });

  it('被 block 插件的命令下架失败 → fail-loud 且不落盘该条禁用（内存阻断仍生效）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    const commandContent = '---\ndescription: x\n---\nx';
    // 源文件与副本一致（归属校验通过），失败必须来自 rm 本身
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'commands', 'inspect.md'), commandContent, 'utf8');
    const commandsDir = path.join(mocks.userConfigDir, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'inspect.md'), commandContent, 'utf8');
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, { commands: ['inspect'], commandPaths: ['commands/inspect.md'] }),
    });
    // 目录去写权限 → deactivatePluginCommands 的 rm 必失败
    await fs.chmod(commandsDir, 0o555);
    try {
      const summary = await rescanStaleInstalledPlugins();

      expect(summary.blocked).toEqual(['demo@trusted-test']);
      const record = (await readState())['demo@trusted-test']!;
      expect(record.isEnabled).toBe(true);
      expect(
        mocks.logError.mock.calls.some((call) => String(call[0]).includes('deactivate')),
      ).toBe(true);
    } finally {
      await fs.chmod(commandsDir, 0o755);
    }
  });

  function realStateIO() {
    return {
      loadInstalledPlugins,
      saveInstalledPlugins,
      deactivatePluginCommands,
      getInstalledPluginsStateVersion,
      saveInstalledPluginsIfVersionUnchanged,
    };
  }

  it('合写窗口（命令下架期间）并发新增安装记录不丢失（CAS 合并）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    const commandContent = '---\ndescription: x\n---\nx';
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'commands', 'inspect.md'), commandContent, 'utf8');
    const commandsDir = path.join(mocks.userConfigDir, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'inspect.md'), commandContent, 'utf8');
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, { commands: ['inspect'], commandPaths: ['commands/inspect.md'] }),
    });

    const summary = await rescanStaleInstalledPlugins({
      ...realStateIO(),
      deactivatePluginCommands: async (args) => {
        // 合写窗口注入并发安装
        const state = await readState();
        state['other@trusted-test'] = makeRecord('/nonexistent-other', { isEnabled: false });
        await writeState(state);
        return deactivatePluginCommands(args);
      },
    });

    expect(summary.blocked).toEqual(['demo@trusted-test']);
    const state = await readState();
    expect(state['other@trusted-test']).toBeDefined();
    expect(state['demo@trusted-test']!.isEnabled).toBe(false);
  });

  it('合写窗口（命令下架期间）并发 disable 不被覆盖（CAS 合并）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    const secondRoot = await makePluginRoot('p2', SAFE_SKILL);
    const commandContent = '---\ndescription: x\n---\nx';
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'commands', 'inspect.md'), commandContent, 'utf8');
    const commandsDir = path.join(mocks.userConfigDir, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'inspect.md'), commandContent, 'utf8');
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, { commands: ['inspect'], commandPaths: ['commands/inspect.md'] }),
      'second@trusted-test': makeRecord(secondRoot),
    });

    await rescanStaleInstalledPlugins({
      ...realStateIO(),
      deactivatePluginCommands: async (args) => {
        // 合写窗口注入并发禁用
        await disablePlugin('second@trusted-test');
        return deactivatePluginCommands(args);
      },
    });

    const state = await readState();
    expect(state['demo@trusted-test']!.isEnabled).toBe(false);
    // 并发禁用保留：合写不再用下架前的旧快照整份覆盖
    expect(state['second@trusted-test']!.isEnabled).toBe(false);
  });

  it('用户改写过的同名命令文件在自动禁用时不被误删（归属校验不过则 warn 留痕）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'commands', 'inspect.md'), '---\ndescription: plugin version\n---\nplugin', 'utf8');
    const commandsDir = path.join(mocks.userConfigDir, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    const userContent = '---\ndescription: user rewrote\n---\nuser';
    await fs.writeFile(path.join(commandsDir, 'inspect.md'), userContent, 'utf8');
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, { commands: ['inspect'], commandPaths: ['commands/inspect.md'] }),
    });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary.blocked).toEqual(['demo@trusted-test']);
    // 禁用照常落盘，但用户改写的文件不删
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(false);
    expect(await fs.readFile(path.join(commandsDir, 'inspect.md'), 'utf8')).toBe(userContent);
    expect(
      mocks.logWarn.mock.calls.some((call) => String(call[0]).includes('not owned')),
    ).toBe(true);
  });

  it('内容仍与插件源一致的命令副本在自动禁用时正常删除', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    const commandContent = '---\ndescription: x\n---\nx';
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'commands', 'inspect.md'), commandContent, 'utf8');
    const commandsDir = path.join(mocks.userConfigDir, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'inspect.md'), commandContent, 'utf8');
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, { commands: ['inspect'], commandPaths: ['commands/inspect.md'] }),
    });

    await rescanStaleInstalledPlugins();

    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(false);
    expect(fsSync.existsSync(path.join(commandsDir, 'inspect.md'))).toBe(false);
  });

  it('scanner.version 高于当前版本按未知版本处理：block 重扫照样禁用', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, {
        scanner: { version: SKILL_GUARD_VERSION + 1, verdict: 'pass', scannedAt: OLD_SCANNED_AT },
      }),
    });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: ['demo@trusted-test'] });
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(false);
  });

  it('scanner.version 高于当前版本的重扫 pass 后回写当前版本（版本收敛）', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({
      'demo@trusted-test': makeRecord(pluginRoot, {
        scanner: { version: SKILL_GUARD_VERSION + 1, verdict: 'pass', scannedAt: OLD_SCANNED_AT },
      }),
    });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: [] });
    expect((await readState())['demo@trusted-test']!.scanner?.version).toBe(SKILL_GUARD_VERSION);
  });

  it('CAS 冲突重试：第一次保存版本漂移 → 重读重合并 → 第二次成功', async () => {
    const pluginRoot = await makePluginRoot('p1', SAFE_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot) });
    let casCalls = 0;

    const summary = await rescanStaleInstalledPlugins({
      ...realStateIO(),
      saveInstalledPluginsIfVersionUnchanged: async (state, expectedVersion) => {
        casCalls += 1;
        if (casCalls === 1) {
          // 模拟并发写：真存一次让内存状态版本漂移，第一次 CAS 必失败
          await saveInstalledPlugins(await loadInstalledPlugins());
        }
        return saveInstalledPluginsIfVersionUnchanged(state, expectedVersion);
      },
    });

    expect(summary).toEqual({ rescanned: 1, blocked: [] });
    expect(casCalls).toBe(2);
    expect((await readState())['demo@trusted-test']!.scanner?.version).toBe(SKILL_GUARD_VERSION);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('CAS 连续冲突 → 有界放弃 + error 留痕 + 结论丢弃（内存阻断仍生效）', async () => {
    const pluginRoot = await makePluginRoot('p1', DANGEROUS_SKILL);
    await writeState({ 'demo@trusted-test': makeRecord(pluginRoot) });
    let casCalls = 0;

    const summary = await rescanStaleInstalledPlugins({
      ...realStateIO(),
      saveInstalledPluginsIfVersionUnchanged: async (state, expectedVersion) => {
        casCalls += 1;
        // 每次都先制造一次并发写，版本永远漂移
        await saveInstalledPlugins(await loadInstalledPlugins());
        return saveInstalledPluginsIfVersionUnchanged(state, expectedVersion);
      },
    });

    expect(casCalls).toBe(3);
    expect(summary.blocked).toEqual(['demo@trusted-test']);
    const record = (await readState())['demo@trusted-test']!;
    // 结论丢弃：磁盘保持原样，本次会话由内存阻断集兜底
    expect(record.isEnabled).toBe(true);
    expect(record.scanner).toBeUndefined();
    expect(mocks.logError.mock.calls.some((call) => String(call[0]).includes('discarded'))).toBe(true);
  });

  it('缺 pluginRoot 的旧记录扫实际装载的复制目录（skillsDir），不扫 sourceMarketplacePath', async () => {
    // sourceMarketplacePath 放安全内容；实际装载真源 skillsDir 复制目录放危险内容
    const safeSource = await makePluginRoot('p-safe-source', SAFE_SKILL);
    const skillsCopyDir = path.join(mocks.userConfigDir, 'skills', 'demo');
    await fs.mkdir(skillsCopyDir, { recursive: true });
    await fs.writeFile(path.join(skillsCopyDir, 'SKILL.md'), DANGEROUS_SKILL, 'utf8');
    const record = makeRecord(safeSource);
    delete (record as { pluginRoot?: string }).pluginRoot;
    delete (record as { skillPaths?: string[] }).skillPaths;
    await writeState({ 'demo@trusted-test': record });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 1, blocked: ['demo@trusted-test'] });
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(false);
  });

  it('拿不到可靠扫描目标（无 pluginRoot、复制目录也不存在）→ 跳过该条并 warn，不猜路径', async () => {
    const record = makeRecord('/nonexistent-source');
    delete (record as { pluginRoot?: string }).pluginRoot;
    delete (record as { skillPaths?: string[] }).skillPaths;
    await writeState({ 'demo@trusted-test': record });

    const summary = await rescanStaleInstalledPlugins();

    expect(summary).toEqual({ rescanned: 0, blocked: [] });
    expect((await readState())['demo@trusted-test']!.isEnabled).toBe(true);
    expect(
      mocks.logWarn.mock.calls.some((call) => String(call[0]).includes('no reliable scan target')),
    ).toBe(true);
  });
});
