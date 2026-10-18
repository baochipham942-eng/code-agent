// ============================================================================
// externalImport* 域 action 分发单测（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 新 action 挂 MEMORY 域（memory.ipc.ts 域表）：检测/技能预览/技能复制/Claude
// 开关四个 action 的载荷直通 externalImport 模块；记忆/指令仍由既有
// memoryHarnessImport* 域 action 承载（同一域表同一装配，不另起管线）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const db = vi.hoisted(() => ({}));
const detect = vi.hoisted(() => vi.fn());
const skillsPreview = vi.hoisted(() => vi.fn());
const skillsApply = vi.hoisted(() => vi.fn());
const setClaudeLegacy = vi.hoisted(() => vi.fn());
const importer = vi.hoisted(() => ({
  dryRunMemoryHarnessImport: vi.fn(async () => ({ summary: { readyToImport: 0 } })),
  applyMemoryHarnessImport: vi.fn(async () => ({ imported: 0, skipped: 0 })),
  confirmMemoryHarnessDirective: vi.fn(async () => ({ confirmed: true, imported: true })),
}));

vi.mock('../../../src/host/services', () => ({
  getDatabase: () => db,
  getSessionManager: () => ({}),
}));
vi.mock('../../../src/host/externalImport/detectSources', () => ({
  detectExternalImportSources: detect,
}));
vi.mock('../../../src/host/externalImport/skillsImport', () => ({
  previewExternalSkillsImport: skillsPreview,
  applyExternalSkillsImport: skillsApply,
  setClaudeLegacySkillsEnabled: setClaudeLegacy,
}));
vi.mock('../../../src/host/memory/importers', () => importer);
vi.mock('../../../src/host/memory/memoryEntryRuntime', () => ({
  listUnifiedMemoryEntries: vi.fn(async () => ({ entries: [] })),
  rebuildMemoryMirrorFromLightFiles: vi.fn(async () => ({})),
  updateMemoryEntry: vi.fn(),
  deleteMemoryEntry: vi.fn(),
  packMemoryEntries: vi.fn(async () => ({})),
  exportMemoryBundleV2: vi.fn(async () => ({})),
  dryRunImportMemoryBundleV2: vi.fn(async () => ({})),
  applyImportMemoryBundleV2: vi.fn(async () => ({})),
  buildActiveMemoryEntryFromInbox: vi.fn(),
  createMemoryMirrorRecord: vi.fn(),
  lightMemoryFileToEntry: vi.fn(),
  storedMemoryToEntry: vi.fn(),
  writeEntryToLightMemory: vi.fn(),
}));
vi.mock('../../../src/host/lightMemory/lightMemoryIpc', () => ({
  listMemoryFiles: vi.fn(async () => []),
  readMemoryFile: vi.fn(async () => ''),
  archiveMemoryFile: vi.fn(async () => true),
  getLightMemoryStats: vi.fn(async () => ({})),
  getLightMemoryHealth: vi.fn(async () => ({})),
  rebuildLightMemoryIndex: vi.fn(async () => ({})),
}));
vi.mock('../../../src/host/memory/memoryEntryReview', () => ({
  batchReviewMemoryEntries: vi.fn(async () => ({ updated: [], skipped: [] })),
}));
vi.mock('../../../src/host/memory/memoryUsageEviction', () => ({
  memoryInjectionPauses: vi.fn(() => new Map()),
  resumeMemoryInjection: vi.fn(() => true),
}));
vi.mock('../../../src/host/memory/memoryInjectionTrace', () => ({
  listMemoryInjectionTraces: vi.fn(async () => []),
}));
vi.mock('../../../src/host/memory/projectMemoryDraft', () => ({
  draftProjectMemory: vi.fn(async () => ({ written: 0 })),
}));
vi.mock('../../../src/host/memory/knowledgeInboxDecision', () => ({
  KNOWLEDGE_INBOX_DECISION_CATEGORY: 'inbox',
  hashInboxContent: vi.fn(() => 'hash'),
  parseKnowledgeInboxDecision: vi.fn(() => null),
  shouldSuppressMemoryByInboxDecision: vi.fn(() => false),
}));
vi.mock('../../../src/host/memory/directiveMemoryConfirmation', () => ({
  respondToDirectiveMemoryConfirmation: vi.fn(() => true),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerMemoryHandlers } from '../../../src/host/ipc/memory.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handlers: Map<string, HandlerFn>;
const call = (action: string, payload?: unknown) =>
  handlers.get(IPC_DOMAINS.MEMORY)!(null, { action, payload } as IPCRequest);

beforeEach(() => {
  vi.clearAllMocks();
  handlers = new Map<string, HandlerFn>();
  registerMemoryHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
});

describe('externalImport* 域 action 分发', () => {
  it('externalImportDetectSources → detectExternalImportSources(getDatabase())', async () => {
    detect.mockResolvedValue({ anyDetected: false, sources: [] });
    const response = await call('externalImportDetectSources');
    expect(response.success).toBe(true);
    expect(detect).toHaveBeenCalledWith(db);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('externalImportSkillsPreview → 载荷直通 sourceIds', async () => {
    skillsPreview.mockResolvedValue({ items: [], summary: { copy: 0, skip: 0 } });
    const response = await call('externalImportSkillsPreview', { sourceIds: ['codex'] });
    expect(response.success).toBe(true);
    expect(skillsPreview).toHaveBeenCalledWith({ sourceIds: ['codex'] });
  });

  it('externalImportSkillsApply → 载荷直通 sourceIds', async () => {
    skillsApply.mockResolvedValue({ copied: 0, skipped: 0, items: [], targetDir: '/skills' });
    const response = await call('externalImportSkillsApply', { sourceIds: ['cursor'] });
    expect(response.success).toBe(true);
    expect(skillsApply).toHaveBeenCalledWith({ sourceIds: ['cursor'] });
  });

  it('externalImportSetClaudeLegacySkills → enabled 透传并回带生效值', async () => {
    setClaudeLegacy.mockResolvedValue({ enabled: false });
    const response = await call('externalImportSetClaudeLegacySkills', { enabled: false });
    expect(response.success).toBe(true);
    expect(setClaudeLegacy).toHaveBeenCalledWith(false);
    expect(response.data).toEqual({ enabled: false });
  });

  it('记忆/说明仍走既有 memoryHarnessImport* 域 action（同表同装配，无第二管线）', async () => {
    vi.stubEnv('CODE_AGENT_HOME', '/tmp/k1a-fixture-home');
    try {
      await call('memoryHarnessImportDryRun', { adapterIds: ['codex-local-custom'] });
      expect(importer.dryRunMemoryHarnessImport).toHaveBeenCalledWith(db, {
        homeDir: '/tmp/k1a-fixture-home',
        adapterIds: ['codex-local-custom'],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('未知 action → INVALID_ACTION（域表兜底不受新 action 影响）', async () => {
    expect(await call('externalImportBogus')).toMatchObject({
      success: false,
      error: { code: 'INVALID_ACTION' },
    });
  });
});
