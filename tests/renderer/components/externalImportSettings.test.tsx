// @vitest-environment jsdom
// ============================================================================
// ExternalImportSettings 首批 renderer 测试（N-EXTHISTORY-IMPORT-K1A）：
// 1. 来源行按检测结果显示 说明/记忆/技能 三类别计数，默认全勾，
//    且「现有设置不受影响」承诺行在场（验收②）
// 2. 无来源 → 空态，不出来源表（验收①的页面半）
// 3. 预览/导入走既有 memoryHarnessImport* 域 action + externalImportSkills*，
//    结果页给出导入/跳过计数与原因；再次导入全跳过（验收③④的 UI 半）
// 4. Claude 技能只读展示「已在原位使用 N」+ 开关（验收⑤的 UI 半）
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemoryImportDryRunResult } from '../../../src/shared/contract/memory';
import type { ExternalImportDetectResult } from '../../../src/shared/contract/externalImport';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());
const invokeChannel = vi.hoisted(() => vi.fn());
const ipcEventHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: invokeChannel,
    invokeDomain,
    on: (channel: string, handler: (payload: unknown) => void) => {
      ipcEventHandlers.set(channel, handler);
      return () => {
        ipcEventHandlers.delete(channel);
      };
    },
    off: vi.fn(),
  },
}));

import { ExternalImportSettings } from '../../../src/renderer/components/features/settings/tabs/ExternalImportSettings';
import { useExternalImportStore } from '../../../src/renderer/stores/externalImportStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function detectResult(overrides: Partial<ExternalImportDetectResult> = {}): ExternalImportDetectResult {
  return {
    homeDir: '/tmp/fixture-home',
    anyDetected: true,
    sources: [
      {
        sourceId: 'codex',
        adapterId: 'codex-local-custom',
        homePath: '~/.codex',
        detected: true,
        categories: [
          { category: 'instructions', count: 1 },
          { category: 'memories', count: 2 },
          { category: 'skills', count: 1 },
        ],
      },
      {
        sourceId: 'claude-code',
        adapterId: 'claude-code',
        homePath: '~/.claude',
        detected: true,
        categories: [
          { category: 'instructions', count: 1 },
          { category: 'memories', count: 1 },
          { category: 'skills', count: 3, readOnly: true },
        ],
      },
    ],
    claudeLegacySkills: { enabled: true, count: 3 },
    ...overrides,
  };
}

function provenance(sourcePath: string) {
  return {
    sourceVendor: 'OpenAI',
    sourceHarness: 'codex-local-custom' as const,
    sourceVersion: null,
    sourcePath,
    sourceScope: 'global',
    sourceHash: `hash-${sourcePath}`,
    sourceMtime: 1,
    sourceFormat: 'markdown',
    sourceMetadata: {},
    verifiedOnDevice: true,
  };
}

function dryRunResult(overrides: Partial<MemoryImportDryRunResult> = {}): MemoryImportDryRunResult {
  return {
    scannedAdapters: ['codex-local-custom'],
    candidates: [
      {
        id: 'import-abc',
        entry: {
          id: 'import-abc',
          schemaVersion: 2,
          status: 'candidate',
          kind: 'reference',
          scope: 'global',
          title: 'Codex 记忆一条',
          summary: '',
          content: 'content',
          source: {
            kind: 'import',
            sourceOfTruth: 'light_file',
            importProvenance: provenance('~/.codex/memories/a.md'),
          },
          evidence: [],
          confidence: 0.7,
          createdAt: 1,
          updatedAt: 1,
        },
        disposition: 'add',
        reason: 'new-content',
      },
      {
        id: 'import-dup',
        entry: {
          id: 'import-dup',
          schemaVersion: 2,
          status: 'candidate',
          kind: 'reference',
          scope: 'global',
          title: '重复的一条',
          summary: '',
          content: 'dup',
          source: {
            kind: 'import',
            sourceOfTruth: 'light_file',
            importProvenance: provenance('~/.codex/memories/b.md'),
          },
          evidence: [],
          confidence: 0.7,
          createdAt: 1,
          updatedAt: 1,
        },
        disposition: 'skip',
        reason: 'duplicate-content-hash',
      },
    ],
    instructions: [
      {
        id: 'instruction:hash1',
        adapterId: 'codex-local-custom',
        title: 'AGENTS.md',
        content: 'rules',
        sourcePath: '~/.codex/AGENTS.md',
        reason: 'directive-confirmation-required',
        contentHash: 'hash1',
        sourceMetadata: {},
      },
    ],
    skipped: [],
    summary: {
      discoveredMemory: 2,
      readyToImport: 1,
      duplicates: 1,
      instructionOnly: 1,
      archived: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  invokeDomain.mockReset();
  invokeChannel.mockReset();
  ipcEventHandlers.clear();
  useAppStore.setState({ language: 'zh' });
  useExternalImportStore.setState({
    status: 'idle',
    result: null,
    error: null,
  });
});

afterEach(cleanup);

function stubDetect(result: ExternalImportDetectResult): void {
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.MEMORY && action === 'externalImportDetectSources') {
      return Promise.resolve(result);
    }
    return Promise.resolve(undefined);
  });
}

describe('ExternalImportSettings 来源选择（验收①②）', () => {
  it('来源行显示 说明/记忆/技能 计数且默认全勾；「现有设置不受影响」在场；Claude 技能只读', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);

    await screen.findByTestId('external-import-sources');

    expect(screen.getByTestId('external-import-unaffected').textContent)
      .toContain('现有设置不受影响');
    const codexRow = screen.getByTestId('external-import-source-codex');
    expect(codexRow.textContent).toContain('Codex');
    expect(codexRow.textContent).toContain('说明 1');
    expect(codexRow.textContent).toContain('记忆 2');
    expect(codexRow.textContent).toContain('技能 1');
    const checkboxes = codexRow.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);
    expect(Array.from(checkboxes).every((box) => (box as HTMLInputElement).checked)).toBe(true);

    // Claude 技能：只读展示（无勾选框），页面顶部计数 + 开关
    const claudeRow = screen.getByTestId('external-import-source-claude-code');
    expect(claudeRow.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    expect(screen.getByTestId('external-import-readonly-claude-code-skills').textContent)
      .toContain('技能 3（原位使用，不复制）');
    expect(screen.getByTestId('external-import-claude-skills').textContent)
      .toContain('Claude 技能：已在原位使用 3 个');
  });

  it('无来源 → 空态文案，不出来源表与预览按钮', async () => {
    stubDetect(detectResult({ anyDetected: false, sources: [], claudeLegacySkills: { enabled: true, count: 0 } }));
    render(<ExternalImportSettings />);

    await screen.findByTestId('external-import-empty');
    expect(screen.queryByTestId('external-import-sources')).toBeNull();
    expect(screen.queryByText('预览要导入的内容')).toBeNull();
  });

  it('预览按勾选来源聚合调用既有管线 dry-run + 技能预览（验收③）', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    // 取消 Claude Code 整行（说明+记忆都不勾），只留 Codex 记忆面 + 技能
    const claudeRow = screen.getByTestId('external-import-source-claude-code');
    for (const box of Array.from(claudeRow.querySelectorAll('input[type="checkbox"]'))) {
      fireEvent.click(box);
    }
    invokeDomain.mockImplementation((domain: string, action: string, payload?: { adapterIds?: string[] }) => {
      if (action === 'memoryHarnessImportDryRun') {
        expect(payload?.adapterIds).toEqual(['codex-local-custom']);
        return Promise.resolve(dryRunResult());
      }
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({
          items: [
            {
              sourceId: 'codex',
              name: 'codex-skill',
              sourcePath: '/tmp/.codex/skills/codex-skill',
              disposition: 'copy',
              reason: 'new-skill',
            },
          ],
          summary: { copy: 1, skip: 0 },
        });
      }
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('预览要导入的内容'));
    await screen.findByTestId('external-import-preview');

    expect(screen.getByTestId('external-import-preview-memory').textContent).toContain('Codex 记忆一条');
    expect(screen.getByTestId('external-import-preview-memory').textContent).toContain('内容与现有记忆重复');
    expect(screen.getByTestId('external-import-preview-skills').textContent).toContain('codex-skill');
    expect(screen.getByTestId('external-import-instructions').textContent)
      .toContain('说明类内容（1 条）');
  });
});

describe('ExternalImportSettings 导入与结果（验收④）', () => {
  it('导入走既有 apply action；结果页给导入/跳过计数与技能原因', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') return Promise.resolve(dryRunResult());
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({ items: [], summary: { copy: 0, skip: 0 } });
      }
      if (action === 'memoryHarnessImportApply') {
        return Promise.resolve({
          imported: 1,
          skipped: 1,
          writtenFiles: ['a.md'],
          entries: [],
          mirrorRebuild: { totalLightFiles: 1, mirrored: 1, created: 1, updated: 0, removed: 0, skipped: [] },
        });
      }
      if (action === 'externalImportSkillsApply') {
        return Promise.resolve({
          targetDir: '/tmp/data/skills',
          copied: 1,
          skipped: 0,
          items: [{ sourceId: 'codex', name: 'codex-skill', action: 'copied' }],
        });
      }
      if (action === 'externalImportDetectSources') return Promise.resolve(detectResult());
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('预览要导入的内容'));
    await screen.findByTestId('external-import-preview');
    fireEvent.click(screen.getByText('开始导入'));
    await screen.findByTestId('external-import-results');

    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.MEMORY,
      'memoryHarnessImportApply',
      expect.objectContaining({ candidateIds: ['import-abc'] }),
    );
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.MEMORY,
      'externalImportSkillsApply',
      expect.objectContaining({ sourceIds: ['codex'] }),
    );
    expect(screen.getByTestId('external-import-results-memory').textContent)
      .toContain('记忆：导入 1 条，跳过 1 条');
    expect(screen.getByTestId('external-import-results-skills').textContent)
      .toContain('技能：复制 1 个，跳过 0 个');
  });

  it('instruction-file（AGENTS.md 类）只供对照：无确认钮、不写记忆', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') {
        return Promise.resolve(dryRunResult({
          instructions: [
            {
              id: 'instruction:agents',
              adapterId: 'codex-local-custom',
              title: 'AGENTS.md',
              content: 'rules',
              sourcePath: '~/.codex/AGENTS.md',
              reason: 'instruction-file',
              contentHash: 'agents-hash',
              sourceMetadata: {},
            },
          ],
        }));
      }
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({ items: [], summary: { copy: 0, skip: 0 } });
      }
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('预览要导入的内容'));
    await screen.findByTestId('external-import-preview');

    expect(screen.getByTestId('external-import-instructions').textContent)
      .toContain('~/.codex/AGENTS.md');
    expect(screen.getByText('只供对照，不写入')).toBeTruthy();
    expect(screen.queryByText('逐条确认')).toBeNull();
    expect(invokeDomain).not.toHaveBeenCalledWith(
      IPC_DOMAINS.MEMORY,
      'memoryHarnessImportConfirmDirective',
      expect.anything(),
    );
  });

  it('逐条确认走既有 confirm IPC + 既有 MEMORY_CONFIRM_RESPONSE 回执通道（验收③）', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    let resolveConfirm: (value: { instructionId: string; confirmed: boolean; imported: boolean }) => void = () => {};
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') return Promise.resolve(dryRunResult());
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({ items: [], summary: { copy: 0, skip: 0 } });
      }
      if (action === 'memoryHarnessImportConfirmDirective') {
        // 宿主侧确认门：广播 MEMORY_CONFIRM_REQUEST，等页面回执后再 resolve
        ipcEventHandlers.get(IPC_CHANNELS.MEMORY_CONFIRM_REQUEST)?.({
          id: 'directive-1',
          content: '所有回复第一行必须是固定标记',
          category: 'import',
          type: 'directive',
          authority: 'directive',
          confidence: 1,
          timestamp: Date.now(),
        });
        return new Promise((resolve) => {
          resolveConfirm = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('预览要导入的内容'));
    await screen.findByTestId('external-import-preview');

    fireEvent.click(screen.getByText('逐条确认'));
    // 就地确认弹窗（全局确认卡会被设置页遮罩盖住）：内容可见 + 确认回执走既有通道
    await screen.findByTestId('external-import-directive-content');
    expect(screen.getByTestId('external-import-directive-content').textContent)
      .toContain('固定标记');
    fireEvent.click(screen.getByText('确认导入'));
    await waitFor(() => {
      expect(invokeChannel).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, {
        id: 'directive-1',
        confirmed: true,
      });
    });
    resolveConfirm({ instructionId: 'instruction:hash1', confirmed: true, imported: true });
    await screen.findByText('已确认并写入');
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.MEMORY,
      'memoryHarnessImportConfirmDirective',
      expect.objectContaining({ instructionId: 'instruction:hash1' }),
    );
  });

  it('Claude 开关切换调用 set action 并刷新检测（验收⑤ UI 半）', async () => {
    let enabled = true;
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-claude-skills');

    invokeDomain.mockImplementation((_domain: string, action: string, payload?: { enabled?: boolean }) => {
      if (action === 'externalImportSetClaudeLegacySkills') {
        enabled = payload?.enabled === true;
        return Promise.resolve({ enabled });
      }
      if (action === 'externalImportDetectSources') {
        return Promise.resolve(detectResult({
          claudeLegacySkills: { enabled, count: 3 },
        }));
      }
      return Promise.resolve(undefined);
    });

    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.MEMORY,
        'externalImportSetClaudeLegacySkills',
        { enabled: false },
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    });
  });
});
