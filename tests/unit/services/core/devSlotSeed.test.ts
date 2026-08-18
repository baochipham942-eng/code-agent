import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureSet = vi.fn();
const readModelCredentialsFromDataDir = vi.fn((_dir: string) => ({}) as Record<string, string>);

vi.mock('../../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({ set: secureSet }),
  readModelCredentialsFromDataDir: (dir: string) => readModelCredentialsFromDataDir(dir),
}));

import { seedDevSlotFromProduction } from '../../../../src/host/services/core/devSlotSeed';

const PROD_CONFIG = {
  models: { default: 'deepseek', providers: { deepseek: { enabled: true, model: 'deepseek-chat' } } },
  // 生产库里的这两块必须留在生产：审批策略与 exec 策略按数据目录隔离（U-1238 口径）。
  permissions: { devModeAutoApprove: true, allow: ['Bash(rm:*)'] },
  execPolicy: { learned: ['npm test'] },
};

describe('seedDevSlotFromProduction', () => {
  let root: string;
  let home: string;
  let prodDir: string;
  const originalHome = process.env.CODE_AGENT_HOME;

  beforeEach(() => {
    secureSet.mockClear();
    readModelCredentialsFromDataDir.mockClear();
    readModelCredentialsFromDataDir.mockReturnValue({});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devslot-seed-'));
    home = path.join(root, 'home');
    prodDir = path.join(home, '.code-agent');
    fs.mkdirSync(prodDir, { recursive: true });
    fs.writeFileSync(path.join(prodDir, 'config.json'), JSON.stringify(PROD_CONFIG), 'utf-8');
    process.env.CODE_AGENT_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const devDir = (name = '.code-agent-dev') => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('空 dev 槽首启动：导入 models + 模型凭据，并留下可见痕迹', () => {
    readModelCredentialsFromDataDir.mockReturnValue({
      'apikey.deepseek': 'sk-prod',
      'serviceBaseUrl.openai': 'https://example.test/v1',
    });
    const dir = devDir();

    const result = seedDevSlotFromProduction(dir, () => 1_700_000_000_000);

    expect(result).toMatchObject({ seeded: true, providers: ['deepseek'], credentialKeys: 2 });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    expect(written.models).toEqual(PROD_CONFIG.models);
    expect(secureSet).toHaveBeenCalledWith('apikey.deepseek', 'sk-prod');
    expect(secureSet).toHaveBeenCalledWith('serviceBaseUrl.openai', 'https://example.test/v1');
    expect(fs.existsSync(path.join(dir, 'SEEDED-FROM-PRODUCTION.txt'))).toBe(true);
  });

  it('只导模型配置：审批策略 / exec 策略一律不跨槽', () => {
    const dir = devDir();
    seedDevSlotFromProduction(dir);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    expect(Object.keys(written)).toEqual(['models']);
    expect(written.permissions).toBeUndefined();
    expect(written.execPolicy).toBeUndefined();
  });

  it('非空 dev 槽：已有 config.json 时零改动（反向变异靶子）', () => {
    const dir = devDir('.code-agent-dev3');
    const existing = JSON.stringify({ models: { default: 'local' } });
    fs.writeFileSync(path.join(dir, 'config.json'), existing, 'utf-8');

    const result = seedDevSlotFromProduction(dir);

    expect(result).toEqual({ seeded: false, reason: 'slot-already-initialized' });
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')).toBe(existing);
    expect(secureSet).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'SEEDED-FROM-PRODUCTION.txt'))).toBe(false);
  });

  it('不是 dev 槽的数据目录：一概不导入（含生产目录自身）', () => {
    for (const name of ['.code-agent', '.code-agent-dev0', '.code-agent-devel', 'e2e-data']) {
      const dir = path.join(home, name);
      fs.mkdirSync(dir, { recursive: true });
      if (name === '.code-agent') continue; // 生产目录本来就有 config.json
      expect(seedDevSlotFromProduction(dir).seeded).toBe(false);
      expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
    }
    expect(secureSet).not.toHaveBeenCalled();
  });

  it('生产目录没有 config.json：dev 槽照常空启动，不写任何东西', () => {
    fs.rmSync(path.join(prodDir, 'config.json'));
    const dir = devDir('.code-agent-dev2');
    expect(seedDevSlotFromProduction(dir)).toEqual({ seeded: false, reason: 'no-production-config' });
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });
});
