// ============================================================================
// ConfigService.save 落盘档位（FB-238）
// 新写的 config.json 必须是 0600、新建的数据目录是 0700。
// 存量文件的收紧由启动扫层（dataDirPermissions）负责，不在此测。
// ============================================================================

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
const originalLogDir = process.env.CODE_AGENT_LOG_DIR;

describe('ConfigService.save config.json 文件档位', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neo-config-mode-'));
    // 故意指向尚不存在的嵌套路径：save() 里的 mkdir 是目录的首建点，mode 在这里生效
    dataDir = join(root, 'fresh', 'data');
    // 测试环境里 electron mock 把 app.getPath('userData') 钉在固定 /tmp 路径，
    // configPath 改由注入给出；日志汇与 env 数据目录都引开，别污染首建断言
    vi.stubEnv('CODE_AGENT_DATA_DIR', join(root, 'env-data'));
    vi.stubEnv('CODE_AGENT_LOG_DIR', join(root, 'logger-sink'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    if (originalLogDir === undefined) delete process.env.CODE_AGENT_LOG_DIR;
    else process.env.CODE_AGENT_LOG_DIR = originalLogDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('新写 config.json 是 0600，新建数据目录是 0700', async () => {
    const { ConfigService } = await import('../../../../src/host/services/core/configService');
    const service = new ConfigService() as unknown as { configPath: string; save: () => Promise<void> };
    service.configPath = join(dataDir, 'config.json');
    await service.save();

    expect(statSync(join(dataDir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });
});
