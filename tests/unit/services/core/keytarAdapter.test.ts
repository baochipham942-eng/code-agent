import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadKeytar } from '../../../../src/host/services/core/keytarAdapter';

/** darwin 夹具：造一个可解析出（或解析不出）默认登录钥匙串的 $HOME */
function stubKeychainHome(withLoginKeychain: boolean): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'neo-keytar-adapter-test-'));
  if (withLoginKeychain) {
    mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
    writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'fixture');
  }
  vi.stubEnv('HOME', home);
  return home;
}

describe('keytarAdapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips the native module in pure CLI mode', () => {
    vi.stubEnv('CODE_AGENT_CLI_MODE', 'true');
    vi.stubEnv('CODE_AGENT_WEB_MODE', '');
    const loader = vi.fn();

    expect(loadKeytar(loader)).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads keytar in the desktop web backend', () => {
    vi.stubEnv('CODE_AGENT_CLI_MODE', 'true');
    vi.stubEnv('CODE_AGENT_WEB_MODE', 'true');
    // darwin 上加载与否还取决于 $HOME 能否解析默认登录钥匙串，钉到带夹具的 HOME
    // 保证任何 macOS runner 上行为确定（无钥匙串的 runner 会走 skip 分支）。
    if (process.platform === 'darwin') tempDirs.push(stubKeychainHome(true));
    const keytar = {} as typeof import('keytar');
    const loader = vi.fn(() => keytar);

    expect(loadKeytar(loader)).toBe(keytar);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('falls back when keytar cannot be loaded', () => {
    vi.stubEnv('CODE_AGENT_CLI_MODE', '');
    vi.stubEnv('CODE_AGENT_WEB_MODE', '');
    if (process.platform === 'darwin') tempDirs.push(stubKeychainHome(true));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(loadKeytar(() => { throw new Error('native module unavailable'); })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      '[SecureStorage] keytar not available:',
      'native module unavailable'
    );
  });

  // N-APPROVAL-LANE-CLICK-DROP-FU1：$HOME 解析不出默认登录钥匙串的无头/隔离环境里，
  // keytar 的 Keychain 调用会卡死在授权 UI 且占满 libuv 线程池（/、/assets/* 零字节、
  // signInEmail 悬死）。此处钉住「加载前探测、缺失即整体放弃 keytar」这道闸。
  it.skipIf(process.platform !== 'darwin')(
    'skips keytar before loading when $HOME has no default login keychain (scratch/headless HOME)',
    () => {
      vi.stubEnv('CODE_AGENT_CLI_MODE', '');
      vi.stubEnv('CODE_AGENT_WEB_MODE', '');
      tempDirs.push(stubKeychainHome(false));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const loader = vi.fn();

      expect(loadKeytar(loader)).toBeNull();
      // 闸必须在 require 之前生效：加载了 native 模块不等于调用，但任何 Keychain
      // 调用（含 setPassword）都已可能把线程池钉死，所以 loader 一次都不许碰。
      expect(loader).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('keytar skipped: no default login keychain under $HOME'));
    }
  );

  it.skipIf(process.platform !== 'darwin')(
    'keeps loading keytar when $HOME resolves a login keychain',
    () => {
      vi.stubEnv('CODE_AGENT_CLI_MODE', '');
      vi.stubEnv('CODE_AGENT_WEB_MODE', '');
      tempDirs.push(stubKeychainHome(true));
      const keytar = {} as typeof import('keytar');
      const loader = vi.fn(() => keytar);

      expect(loadKeytar(loader)).toBe(keytar);
      expect(loader).toHaveBeenCalledOnce();
    }
  );
});
