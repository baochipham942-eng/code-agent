import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveChannelDataDir, resolveChannelWebPort, expandDataDirLongPath } from '../../../src/web/channelDataDir';
import { MAX_DEV_SLOT } from '../../../src/shared/devSlot';

const HOME = '/Users/test';
const DEV_DIR = path.join(HOME, '.code-agent-dev');
const DEV2_DIR = path.join(HOME, '.code-agent-dev2');

/** 主检出语境：不是工作树，槽位恒空闲。 */
const mainCtx = () => ({ isGitWorktree: () => false, isSlotFree: () => true });
/** 工作树语境：isFree 决定哪些槽空闲。 */
const worktreeCtx = (free: (slot: number) => boolean) => ({
  isGitWorktree: () => true,
  isSlotFree: free,
  describeSlotOccupancy: (slot: number) => `  槽 ${slot}：被测试进程占用`,
});

describe('resolveChannelDataDir — 显式指定永远优先', () => {
  it('显式 CODE_AGENT_DATA_DIR 时不覆盖（原样尊重，返回空决策）', () => {
    expect(
      resolveChannelDataDir({ CODE_AGENT_DATA_DIR: '/custom/dir', NODE_ENV: 'production' }, HOME),
    ).toEqual({});
    expect(resolveChannelDataDir({ CODE_AGENT_DATA_DIR: '/custom/dir' }, HOME, worktreeCtx(() => false))).toEqual({});
  });

  it('显式 CODE_AGENT_DATA_DIR 指向槽 1 目录 → 照办但标记 slot1Notice', () => {
    const decision = resolveChannelDataDir({ CODE_AGENT_DATA_DIR: DEV_DIR }, HOME, worktreeCtx(() => false));
    expect(decision.dataDir).toBeUndefined(); // 不覆盖显式值
    expect(decision.slot).toBe(1);
    expect(decision.slot1Notice).toBe(true);
  });

  it('空字符串 CODE_AGENT_DATA_DIR 视为未设置（production 下照走生产通道）', () => {
    expect(resolveChannelDataDir({ CODE_AGENT_DATA_DIR: '   ', NODE_ENV: 'production' }, HOME)).toEqual({});
  });

  it('显式 NEO_SLOT=1 → 用槽 1 且给出提示（即使在工作树里也照办）', () => {
    const decision = resolveChannelDataDir({ NEO_SLOT: '1' }, HOME, worktreeCtx(() => true));
    expect(decision).toEqual({ dataDir: DEV_DIR, slot: 1, reason: 'explicit-slot', slot1Notice: true });
  });

  it('显式 NEO_SLOT=3 槽空闲 → 用槽 3（优先于工作树自动选槽）', () => {
    const decision = resolveChannelDataDir({ NEO_SLOT: '3' }, HOME, worktreeCtx(() => true));
    expect(decision).toEqual({
      dataDir: path.join(HOME, '.code-agent-dev3'),
      slot: 3,
      reason: 'explicit-slot',
      slot1Notice: false,
    });
  });

  it('显式 NEO_SLOT 槽被占用 → fail-closed 抛错并带占用详情，不回落', () => {
    expect(() =>
      resolveChannelDataDir({ NEO_SLOT: '2' }, HOME, worktreeCtx(() => false)),
    ).toThrowError(/dev 槽 2.*正有实例占用/s);
    expect(() => resolveChannelDataDir({ NEO_SLOT: '2' }, HOME, worktreeCtx(() => false))).toThrowError(
      /被测试进程占用/,
    );
  });

  it('NEO_SLOT 非法（0/10/abc）→ 抛错不回退（parseDevSlot 规则）', () => {
    for (const raw of ['0', '10', 'abc', '02']) {
      expect(() => resolveChannelDataDir({ NEO_SLOT: raw }, HOME, mainCtx())).toThrowError(/Invalid NEO_SLOT/);
    }
  });
});

describe('resolveChannelDataDir — 槽位默认决策', () => {
  it('主检出（非工作树）→ 槽 1（历史行为零迁移，无提示）', () => {
    expect(resolveChannelDataDir({}, HOME)).toEqual({ dataDir: DEV_DIR, slot: 1, reason: 'main-checkout' });
    expect(resolveChannelDataDir({}, HOME, mainCtx())).toEqual({
      dataDir: DEV_DIR,
      slot: 1,
      reason: 'main-checkout',
    });
    expect(resolveChannelDataDir({}, HOME, mainCtx()).slot1Notice).toBeUndefined();
  });

  it('工作树 + 槽 2 空闲 → 槽 2（不许用槽 1）', () => {
    expect(resolveChannelDataDir({}, HOME, worktreeCtx(() => true))).toEqual({
      dataDir: DEV2_DIR,
      slot: 2,
      reason: 'worktree-auto',
    });
  });

  it('工作树 + 槽 2..4 占用 → 自动跳到最小空闲槽 5', () => {
    const decision = resolveChannelDataDir({}, HOME, worktreeCtx(slot => slot >= 5));
    expect(decision.slot).toBe(5);
    expect(decision.dataDir).toBe(path.join(HOME, '.code-agent-dev5'));
  });

  it('工作树 + 槽 2..9 全占 → 抛错不回落槽 1，报错给出显式指定指引', () => {
    const allBusy = worktreeCtx(() => false);
    expect(() => resolveChannelDataDir({}, HOME, allBusy)).toThrowError(
      new RegExp(`不许用槽 1.*槽 2\\..${MAX_DEV_SLOT} 又全被占用.*NEO_SLOT=<n> 或 CODE_AGENT_DATA_DIR=<path>`, 's'),
    );
    // 关键断言：绝不静默给出槽 1 的数据目录
    let threw = false;
    try {
      resolveChannelDataDir({}, HOME, allBusy);
    } catch (error) {
      threw = true;
      expect((error as Error).message).not.toContain(DEV_DIR);
    }
    expect(threw).toBe(true);
  });

  it('工作树 + 无 describeSlotOccupancy → 全占报错仍有占位详情行', () => {
    const bare = { isGitWorktree: () => true, isSlotFree: () => false };
    expect(() => resolveChannelDataDir({}, HOME, bare)).toThrowError(/占用详情不可用/);
  });

  it('NODE_ENV 缺省 / development（cargo tauri dev / npm run dev）→ 走槽位逻辑', () => {
    expect(resolveChannelDataDir({}, HOME, mainCtx()).dataDir).toBe(DEV_DIR);
    expect(resolveChannelDataDir({ NODE_ENV: 'development' }, HOME, mainCtx()).dataDir).toBe(DEV_DIR);
  });

  it('CODE_AGENT_CHANNEL=dev 即使 NODE_ENV=production 也走槽位逻辑（打包测试包冗余信号）', () => {
    expect(resolveChannelDataDir({ NODE_ENV: 'production', CODE_AGENT_CHANNEL: 'dev' }, HOME, mainCtx())).toEqual({
      dataDir: DEV_DIR,
      slot: 1,
      reason: 'main-checkout',
    });
  });

  it('CODE_AGENT_CHANNEL 大小写不敏感', () => {
    expect(
      resolveChannelDataDir({ NODE_ENV: 'production', CODE_AGENT_CHANNEL: 'DEV' }, HOME, mainCtx()).dataDir,
    ).toBe(DEV_DIR);
  });

  it('NODE_ENV=production → 行为不变（不切目录），工作树逻辑只在 dev 通道生效', () => {
    expect(resolveChannelDataDir({ NODE_ENV: 'production' }, HOME)).toEqual({});
    expect(resolveChannelDataDir({ NODE_ENV: 'production' }, HOME, worktreeCtx(() => false))).toEqual({});
  });
});

describe('resolveChannelWebPort — 端口跟着槽位决策走', () => {
  it('有槽位决策且无显式端口 → 注入 devSlotWebPort(slot)（工作树槽 3 → 8183，不是生产 8180）', () => {
    expect(resolveChannelWebPort({}, { slot: 3, reason: 'worktree-auto' })).toEqual({ port: 8183 });
    expect(resolveChannelWebPort({}, { dataDir: DEV2_DIR, slot: 2, reason: 'worktree-auto' })).toEqual({ port: 8182 });
  });

  it('主检出槽 1 → 8181（dev 槽 1 端口，不再占生产 8180）', () => {
    expect(resolveChannelWebPort({}, { dataDir: DEV_DIR, slot: 1, reason: 'main-checkout' })).toEqual({ port: 8181 });
  });

  it('显式数据目录未指向槽 1 → 无槽位决策 → 不动端口（显式目录的使用方自管端口）', () => {
    expect(resolveChannelWebPort({ WEB_PORT: '9999' }, {})).toEqual({});
    expect(resolveChannelWebPort({}, {})).toEqual({});
  });

  it('显式 WEB_PORT 照办不覆盖（与 CODE_AGENT_DATA_DIR 同口径）', () => {
    expect(resolveChannelWebPort({ WEB_PORT: '9999' }, { slot: 3, reason: 'worktree-auto' })).toEqual({
      explicitPortMismatch: expect.stringContaining('9999'),
    });
    expect(resolveChannelWebPort({ WEB_PORT: '9999' }, { slot: 3 }).port).toBeUndefined();
  });

  it('显式端口与槽端口不一致 → 提示同时带两个端口值，让人当场看清错位', () => {
    const decision = resolveChannelWebPort({ WEB_PORT: '8180' }, { slot: 3, reason: 'worktree-auto' });
    expect(decision.port).toBeUndefined();
    expect(decision.explicitPortMismatch).toContain('8180');
    expect(decision.explicitPortMismatch).toContain('8183');
  });

  it('显式端口与槽端口一致（Rust spawn 注入口径）→ 安静放行，不重写不提示', () => {
    expect(resolveChannelWebPort({ WEB_PORT: '8183', CODE_AGENT_WEB_PORT: '8183' }, { slot: 3 })).toEqual({});
  });

  it('只显式 CODE_AGENT_WEB_PORT（无 WEB_PORT）→ 同样视为显式，不覆盖', () => {
    expect(resolveChannelWebPort({ CODE_AGENT_WEB_PORT: '8183' }, { slot: 3 })).toEqual({});
    expect(
      resolveChannelWebPort({ CODE_AGENT_WEB_PORT: '9199' }, { slot: 3, reason: 'explicit-slot' }).port,
    ).toBeUndefined();
  });
});

describe('expandDataDirLongPath', () => {
  it('不存在的目录先创建再解析（首启场景）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'expand-longpath-'));
    const target = path.join(base, 'nested', 'data-dir');
    const result = expandDataDirLongPath(target);
    expect(fs.statSync(result).isDirectory()).toBe(true);
    // 解析后指向同一物理目录（macOS 上 /var→/private/var 会展开，路径字符串可能变化）
    expect(fs.realpathSync.native(target)).toBe(result);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('symlink 展开为真实路径（8.3 短名在 win32 的同族行为）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'expand-longpath-'));
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(expandDataDirLongPath(link)).toBe(fs.realpathSync.native(real));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('无法创建/解析时返回原值（fail-open 不改坏数据目录）', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'expand-longpath-')), 'a-file');
    fs.writeFileSync(file, '');
    const target = path.join(file, 'child'); // 父路径是文件，mkdir 必失败
    expect(expandDataDirLongPath(target)).toBe(target);
  });
});
