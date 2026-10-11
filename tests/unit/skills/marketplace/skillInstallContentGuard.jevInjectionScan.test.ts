import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevSystemOneCall } from '../../../../src/shared/constants/jevQuestions';

const jevMock = vi.hoisted(() => ({
  calls: [] as Array<{ source: string; text: string }>,
  behavior: 'flag' as 'flag' | 'clear' | 'throw' | 'skip',
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMock,
}));

// 判官替身只注入 systemOne，正则层、开关和远端来源判断仍走真实现。
vi.mock('../../../../src/host/security/jevInjectionScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/security/jevInjectionScan')>();
  const mockJudge: JevSystemOneCall = async () => {
    if (jevMock.behavior === 'throw') throw new Error('mock judge unavailable');
    if (jevMock.behavior === 'clear') {
      return { injection: { noul: 0.1 }, exfil_request: { noul: 0.2 } };
    }
    return { injection: { noul: 0.99 }, exfil_request: { noul: 0.99 } };
  };
  return {
    ...actual,
    scanWithJevInjection: async (
      source: string,
      text: string,
      _systemOne?: JevSystemOneCall,
      signal?: AbortSignal,
    ) => {
      jevMock.calls.push({ source, text });
      if (jevMock.behavior === 'skip') {
        return { skipped: true, flagged: false, injection: 0, exfilRequest: 0, reason: 'unavailable' as const };
      }
      return actual.scanWithJevInjection(source, text, mockJudge, signal);
    },
  };
});

import {
  scanInstallContent,
  scanPluginRootContent,
} from '../../../../src/host/skills/marketplace/skillInstallContentGuard';
import { assertPluginRescanPassesForEnable } from '../../../../src/host/skills/marketplace/installedPluginRescan';
import type { InstalledPluginRecord } from '../../../../src/host/skills/marketplace/types';

const SAFE_SKILL = '---\nname: demo\n---\n# Demo\n\n这是普通的安装说明。\n';

describe('remote skill Jev advisory at install', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('CODE_AGENT_JEV_INJECTION_SCAN', '1');
    jevMock.calls = [];
    jevMock.behavior = 'flag';
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-jev-install-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function makeInstallRoot(): Promise<string> {
    await fs.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'SKILL.md'), SAFE_SKILL, 'utf8');
    await fs.writeFile(path.join(tempRoot, 'docs', 'guide.md'), '普通文档内容。', 'utf8');
    return tempRoot;
  }

  it.each(['official-registry', 'unsigned-github-archive'] as const)(
    'pass + %s calls remote_skill and returns an advisory without changing deterministic fields',
    async (sourceTrust) => {
      const rootDir = await makeInstallRoot();

      const result = await scanInstallContent({
        pluginSpec: 'demo@marketplace',
        sourceTrust,
        rootDir,
      });

      expect(result.jevAdvisory).toEqual({ injection: 0.99, exfilRequest: 0.99 });
      expect(result.cautionHits).toEqual([]);
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(jevMock.calls).toHaveLength(1);
      expect(jevMock.calls[0]?.source).toBe('remote_skill');
      const text = jevMock.calls[0]?.text ?? '';
      expect(text.startsWith(`SKILL.md\n${SAFE_SKILL}`)).toBe(true);
      expect(text).toContain('docs/guide.md\n普通文档内容。');
      expect(text.indexOf(SAFE_SKILL)).toBeLessThan(text.indexOf('docs/guide.md'));
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Jev advisory flagged remote skill install',
        expect.objectContaining({
          pluginSpec: 'demo@marketplace',
          sourceTrust,
          injection: 0.99,
          exfilRequest: 0.99,
        }),
      );
    },
  );

  it('builtin and local-marketplace never call the judge', async () => {
    const rootDir = await makeInstallRoot();

    await scanInstallContent({
      pluginSpec: 'builtin@marketplace',
      sourceTrust: 'builtin',
      rootDir,
    });
    await scanInstallContent({
      pluginSpec: 'local@marketplace',
      sourceTrust: 'local-marketplace',
      rootDir,
    });

    expect(jevMock.calls).toHaveLength(0);
  });

  it('unflagged and skipped judge results leave jevAdvisory absent', async () => {
    const rootDir = await makeInstallRoot();

    jevMock.behavior = 'clear';
    const clear = await scanInstallContent({
      pluginSpec: 'clear@marketplace',
      sourceTrust: 'official-registry',
      rootDir,
    });
    expect(clear).not.toHaveProperty('jevAdvisory');

    jevMock.behavior = 'skip';
    const skipped = await scanInstallContent({
      pluginSpec: 'skip@marketplace',
      sourceTrust: 'official-registry',
      rootDir,
    });
    expect(skipped).not.toHaveProperty('jevAdvisory');
  });

  it('feature flag off leaves the install result unchanged and adds no advisory', async () => {
    const rootDir = await makeInstallRoot();
    vi.stubEnv('CODE_AGENT_JEV_INJECTION_SCAN', '0');

    const result = await scanInstallContent({
      pluginSpec: 'disabled@marketplace',
      sourceTrust: 'official-registry',
      rootDir,
    });

    expect(result).not.toHaveProperty('jevAdvisory');
    expect(result.cautionHits).toEqual([]);
  });

  it.each(['throw', 'skip'] as const)('judge %s preserves the pre-advisory return value', async (behavior) => {
    const rootDir = await makeInstallRoot();
    jevMock.behavior = behavior;
    const baseline = await scanPluginRootContent({
      pluginSpec: 'demo@marketplace',
      sourceTrust: 'official-registry',
      rootDir,
    });

    const result = await scanInstallContent({
      pluginSpec: 'demo@marketplace',
      sourceTrust: 'official-registry',
      rootDir,
    });

    expect(result).toEqual({ cautionHits: baseline.cautionHits, contentHash: baseline.contentHash });
  });

  it('installedPluginRescan path makes zero judge calls', async () => {
    const rootDir = await makeInstallRoot();
    const record = {
      plugin: 'demo',
      marketplace: 'trusted',
      sourceTrust: 'official-registry',
      scope: 'user',
      isEnabled: true,
      installedAt: '2026-10-10T00:00:00.000Z',
      pluginRoot: rootDir,
      sourceMarketplacePath: rootDir,
      skills: ['demo'],
      skillPaths: ['skills/demo'],
    } as InstalledPluginRecord;

    await assertPluginRescanPassesForEnable('demo@trusted', record);

    expect(jevMock.calls).toHaveLength(0);
  });
});
