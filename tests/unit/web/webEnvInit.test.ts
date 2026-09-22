import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============================================================================
// webEnvInit import 期副作用测试 — 数据目录 + 端口都要跟着槽位决策走
// ============================================================================
// webEnvInit 的全部价值在 import 期改 process.env（必须早于一切其他模块加载），
// 纯函数测试（channelDataDir.test.ts）钉不住「应用」这半步——把 webEnvInit 里的
// 端口注入摘掉，纯函数测试照样绿。所以这里每条用例都 resetModules 后带着预设 env
// 重新动态 import，断言 process.env 真的被改。
//
// 确定性：显式 CODE_AGENT_DATA_DIR 走 resolveChannelDataDir 的第一分支，先于一切
// git/lsof 探测返回 → 用例不依赖机器上有没有活实例、本检出是不是工作树。HOME 指到
// mkdtemp 临时目录，绝不触碰真实 ~/.code-agent-dev*。
// ============================================================================

const ENV_KEYS = [
  'HOME',
  'NODE_ENV',
  'CODE_AGENT_CHANNEL',
  'CODE_AGENT_DATA_DIR',
  'CODE_AGENT_WEB_PORT',
  'CODE_AGENT_CLI_MODE',
  'CODE_AGENT_WEB_MODE',
  'CODE_AGENT_TAURI_BOOT_TOKEN',
  'NEO_SLOT',
  'WEB_PORT',
] as const;

/** devSlotDataDirName(1) 的字面量只在此处出现一次，用于拼显式槽 1 目录。 */
const SLOT1_DIR_NAME = '.code-agent-dev';

describe('webEnvInit — 槽位决策应用到 process.env（数据目录 + 端口）', () => {
  let savedEnv: Record<string, string | undefined>;
  let fakeHome: string;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'webenvinit-home-'));
    // 显式数据目录 + 假 HOME：resolveChannelDataDir 第一分支直接命中，零探测。
    process.env.HOME = fakeHome;
    process.env.NODE_ENV = 'development';
    process.env.CODE_AGENT_DATA_DIR = path.join(fakeHome, SLOT1_DIR_NAME);
    delete process.env.WEB_PORT;
    delete process.env.CODE_AGENT_WEB_PORT;
    delete process.env.CODE_AGENT_CHANNEL;
    delete process.env.NEO_SLOT;
    delete process.env.CODE_AGENT_TAURI_BOOT_TOKEN;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** 带当前 process.env 重新执行 webEnvInit 的 import 期副作用。 */
  async function importFreshWebEnvInit(): Promise<void> {
    vi.resetModules();
    await import('../../../src/web/webEnvInit');
  }

  it('槽位决策落定 → WEB_PORT 与 CODE_AGENT_WEB_PORT 同值注入槽位端口（8181，不是生产 8180）', async () => {
    await importFreshWebEnvInit();
    // webServer 绑定读 WEB_PORT；auth / desktopShellDiagnostics 兜底读 CODE_AGENT_WEB_PORT。
    // 摘掉 webEnvInit 的端口注入（本单 R2 之前的现状）这两条都会红——数据目录去了
    // 槽 N、进程却照绑生产 8180，正是「守卫的端口判据永远探不到本进程」的老疤。
    expect(process.env.WEB_PORT).toBe('8181');
    expect(process.env.CODE_AGENT_WEB_PORT).toBe('8181');
  });

  it('端口注入不越权：显式 WEB_PORT 照办不覆盖，仅提示一行说清与槽端口的错位', async () => {
    process.env.WEB_PORT = '9999';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importFreshWebEnvInit();
    expect(process.env.WEB_PORT).toBe('9999');
    expect(process.env.CODE_AGENT_WEB_PORT).toBeUndefined();
    const mismatchWarns = warnSpy.mock.calls.map(args => args.join(' ')).filter(text => text.includes('9999'));
    expect(mismatchWarns).toHaveLength(1);
    expect(mismatchWarns[0]).toContain('8181'); // 显式值与槽端口都在提示里
  });

  it('生产通道（NODE_ENV=production 且无 dev 标记）→ 端口不动，沿用生产默认 8180', async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    process.env.NODE_ENV = 'production';
    await importFreshWebEnvInit();
    expect(process.env.WEB_PORT).toBeUndefined();
    expect(process.env.CODE_AGENT_WEB_PORT).toBeUndefined();
  });

  it('数据目录照旧应用（R1 行为回归锚：显式值不被覆盖，长路径照常展开）', async () => {
    await importFreshWebEnvInit();
    // expandDataDirLongPath 会把 /var → /private/var 一类 symlink 展开（issue #1072），断真值。
    expect(process.env.CODE_AGENT_DATA_DIR).toBe(
      fs.realpathSync.native(path.join(fakeHome, SLOT1_DIR_NAME)),
    );
  });
});
