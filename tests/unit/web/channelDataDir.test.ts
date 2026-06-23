import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolveChannelDataDir } from '../../../src/web/channelDataDir';

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
