import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userConfigDir: '',
  projectConfigDir: '',
  marketplaceRoot: '',
  getMarketplaceInfo: vi.fn(),
  listMarketplaces: vi.fn(),
  reloadSkills: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  logSecurityIncident: vi.fn(),
  currentUser: { id: 'user-audit-1' } as { id: string } | null,
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
  getProjectConfigDir: () => mocks.projectConfigDir,
  getCommandsDir: (workingDirectory?: string) => ({
    user: `${mocks.userConfigDir}/commands`,
    ...(workingDirectory ? { project: `${mocks.projectConfigDir}/commands` } : {}),
  }),
}));

vi.mock('../../../../src/host/skills/marketplace/marketplaceService', () => ({
  getMarketplaceInfo: (...args: unknown[]) => mocks.getMarketplaceInfo(...args),
  listMarketplaces: (...args: unknown[]) => mocks.listMarketplaces(...args),
}));

vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    reload: mocks.reloadSkills,
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../../../src/host/security/auditLogger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/security/auditLogger')>();
  return {
    ...actual,
    getAuditLogger: () => ({
      logSecurityIncident: (...args: unknown[]) => mocks.logSecurityIncident(...args),
    }),
  };
});

vi.mock('../../../../src/host/services/auth/authService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/auth/authService')>();
  return {
    ...actual,
    getAuthService: () => ({
      getCurrentUser: () => mocks.currentUser,
    }),
  };
});

import { ExtensionOpsService, getMarketplaceExtensionStatus } from '../../../../src/host/services/plugins/extensionOpsService';
import { listInstalledPlugins } from '../../../../src/host/skills/marketplace/installService';
import { SkillCautionConfirmationRequiredError } from '../../../../src/host/skills/marketplace/skillInstallCautionGate';
import type { SkillCautionConfirmationRequired } from '../../../../src/shared/contract/skillInstallCaution';

describe('ExtensionOpsService marketplace status mapping', () => {
  it('marks enabled skill and command plugins as active runtime extensions', () => {
    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['skill'],
      skills: ['review'],
    })).toBe('active');

    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['command'],
      commands: ['inspect'],
    })).toBe('active');
  });

  it('keeps enabled provider theme and UI assets inactive until adapters exist', () => {
    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['provider'],
      skills: [],
      commands: [],
    })).toBe('inactive');

    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['theme'],
      skills: [],
      commands: [],
    })).toBe('inactive');

    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['ui'],
      skills: [],
      commands: [],
    })).toBe('inactive');
  });

  it('marks disabled marketplace plugins as disabled regardless of type', () => {
    expect(getMarketplaceExtensionStatus({
      isEnabled: false,
      types: ['command'],
      commands: ['inspect'],
    })).toBe('disabled');
  });
});

describe('ExtensionOpsService install skill caution gate (real temp local marketplace)', () => {
  let tempRoot: string;
  let svc: InstanceType<typeof ExtensionOpsService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-extops-'));
    mocks.userConfigDir = path.join(tempRoot, 'user-config');
    mocks.projectConfigDir = path.join(tempRoot, 'project-config');
    mocks.marketplaceRoot = path.join(tempRoot, 'marketplace');

    const skillDir = path.join(mocks.marketplaceRoot, 'skills', 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nrm -rf ./build\n', 'utf8');

    mocks.getMarketplaceInfo.mockResolvedValue({
      rootDir: mocks.marketplaceRoot,
      manifest: {
        name: 'trusted-test',
        plugins: [{
          name: 'demo',
          source: './',
          skills: ['skills/demo'],
        }],
      },
    });
    mocks.listMarketplaces.mockResolvedValue({
      'trusted-test': {
        source: { source: 'directory', path: mocks.marketplaceRoot },
        installLocation: mocks.marketplaceRoot,
        lastUpdated: '2026-10-16T00:00:00.000Z',
      },
    });
    mocks.reloadSkills.mockResolvedValue(undefined);

    svc = new ExtensionOpsService();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('stalls a caution install without a token and installs with the first scan token', async () => {
    // 第一趟：无 token → host 门抛 SkillCautionConfirmationRequiredError，盘上不落任何东西
    let pending: SkillCautionConfirmationRequired | undefined;
    try {
      await svc.install('demo@trusted-test');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillCautionConfirmationRequiredError);
      if (error instanceof SkillCautionConfirmationRequiredError) pending = error.result;
    }
    if (!pending) throw new Error('expected SKILL_CAUTION_CONFIRMATION_REQUIRED');

    expect(pending).toMatchObject({
      success: false,
      code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED',
      pluginSpec: 'demo@trusted-test',
      sourceTrust: 'local-marketplace',
      cautionHits: [expect.objectContaining({
        file: 'skills/demo/SKILL.md',
        ruleId: 'recursive_delete_targeted',
        snippet: 'rm -rf ./build',
      })],
    });
    expect(pending.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await listInstalledPlugins())['demo@trusted-test']).toBeUndefined();
    const pluginsDir = path.join(mocks.userConfigDir, 'plugins');
    const residual = fsSync.existsSync(pluginsDir) ? await fs.readdir(pluginsDir) : [];
    expect(residual.filter((entry) => entry.includes('.staging-') || entry.includes('demo__trusted-test'))).toEqual([]);

    // 第二趟：携第一趟扫描出的 token → 落盘安装
    await expect(svc.install('demo@trusted-test', { cautionConfirmationToken: pending.confirmationToken }))
      .resolves.toBeUndefined();
    const record = (await listInstalledPlugins())['demo@trusted-test'];
    expect(record).toMatchObject({ sourceTrust: 'local-marketplace' });
    expect(fsSync.existsSync(path.join(record!.pluginRoot!, 'skills', 'demo', 'SKILL.md'))).toBe(true);
  });
});
