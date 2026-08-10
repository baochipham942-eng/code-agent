import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveChannelDataDir, expandDataDirLongPath } from '../../../src/web/channelDataDir';

const HOME = '/Users/test';
const DEV_DIR = path.join(HOME, '.code-agent-dev');

describe('resolveChannelDataDir', () => {
  it('显式 CODE_AGENT_DATA_DIR 时不覆盖（返回 undefined）', () => {
    expect(
      resolveChannelDataDir({ CODE_AGENT_DATA_DIR: '/custom/dir', NODE_ENV: 'production' }, HOME),
    ).toBeUndefined();
  });

  it('NODE_ENV=production 且无 dev 通道 → 沿用生产（返回 undefined）', () => {
    expect(resolveChannelDataDir({ NODE_ENV: 'production' }, HOME)).toBeUndefined();
  });

  it('NODE_ENV 缺省（cargo tauri dev / npm run dev）→ 切到 .code-agent-dev', () => {
    expect(resolveChannelDataDir({}, HOME)).toBe(DEV_DIR);
  });

  it('NODE_ENV=development → 切到 .code-agent-dev', () => {
    expect(resolveChannelDataDir({ NODE_ENV: 'development' }, HOME)).toBe(DEV_DIR);
  });

  it('CODE_AGENT_CHANNEL=dev 即使 NODE_ENV=production 也切到 dev（打包测试包冗余信号）', () => {
    expect(
      resolveChannelDataDir({ NODE_ENV: 'production', CODE_AGENT_CHANNEL: 'dev' }, HOME),
    ).toBe(DEV_DIR);
  });

  it('CODE_AGENT_CHANNEL 大小写不敏感', () => {
    expect(
      resolveChannelDataDir({ NODE_ENV: 'production', CODE_AGENT_CHANNEL: 'DEV' }, HOME),
    ).toBe(DEV_DIR);
  });

  it('空字符串 CODE_AGENT_DATA_DIR 视为未设置', () => {
    expect(resolveChannelDataDir({ CODE_AGENT_DATA_DIR: '   ', NODE_ENV: 'production' }, HOME)).toBeUndefined();
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
