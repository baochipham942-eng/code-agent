// @vitest-environment jsdom
// ============================================================================
// ExternalImportSettings 首批 renderer 测试（N-EXTHISTORY-IMPORT-K1A）：
// 1. 来源行按检测结果显示 说明/记忆/技能 三类别计数，默认全勾，
//    且「现有设置不受影响」承诺行在场（验收②）
// 2. 无来源 → 空态，不出来源表（验收①的页面半）
// 3. 预览/导入走既有 memoryHarnessImport* 域 action + externalImportSkills*，
//    结果页给出导入/跳过计数与原因；再次导入全跳过（验收③④的 UI 半）
//    FU2 加钉：结果页技能摘要/明细只显大白话——无路径、无裸 error、无裸来源 id，
//    copy-failed 走 i18n 标签（zh/en 双语），「查看技能」开能力中心技能页。
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
  useAppStore.setState({ language: 'zh', settingsCapabilityFocus: null });
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
  it('导入走既有 apply action；结果页给导入/跳过计数与技能原因（FU2 验收①：无路径）', async () => {
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
          skipped: 1,
          items: [
            { sourceId: 'codex', name: 'alpha', action: 'copied' },
            { sourceId: 'cursor', name: 'beta', action: 'skipped', reason: 'target-name-exists' },
          ],
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
    // FU2 验收①：摘要说「已放进 Neo 技能库」，不再出现任何绝对路径
    const skillsBlock = screen.getByTestId('external-import-results-skills').textContent ?? '';
    expect(skillsBlock).toContain('技能：复制 1 个，跳过 1 个，已放进 Neo 技能库');
    expect(skillsBlock).not.toContain('/tmp');
    // 行内容：来源显示名（非裸 id）+ 大白话原因
    expect(skillsBlock).toContain('Codex · alpha · 已复制');
    expect(skillsBlock).toContain('Cursor · beta · Neo 已有同名技能，跳过');
    // 状态词本地化：中文界面不得出现裸 copied/skipped（返修钉子）
    expect(skillsBlock).not.toMatch(/\b(copied|skipped)\b/);
  });

  it('copy-failed 行只显 i18n 标签：裸错误、路径、来源 id 都不出现（FU2 验收②）', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') return Promise.resolve(dryRunResult());
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({ items: [], summary: { copy: 0, skip: 0 } });
      }
      if (action === 'externalImportSkillsApply') {
        return Promise.resolve({
          targetDir: '/tmp/data/skills',
          copied: 1,
          skipped: 1,
          items: [
            { sourceId: 'codex', name: 'alpha', action: 'copied' },
            {
              sourceId: 'codex',
              name: 'broken-one',
              action: 'skipped',
              reason: 'copy-failed',
              error: "EACCES: permission denied, open '/tmp/data/skills/broken-one/SKILL.md'",
            },
          ],
        });
      }
      if (action === 'externalImportDetectSources') return Promise.resolve(detectResult());
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('预览要导入的内容'));
    await screen.findByTestId('external-import-preview');
    fireEvent.click(screen.getByText('开始导入'));
    await screen.findByTestId('external-import-results');

    const skillsBlock = screen.getByTestId('external-import-results-skills').textContent ?? '';
    expect(skillsBlock).toContain('复制失败，已跳过');
    expect(skillsBlock).not.toContain('EACCES');
    expect(skillsBlock).not.toContain('/tmp');
    // 来源 id 裸串不出现（显示名 Codex 是大写，不与小写 id 冲突）
    expect(skillsBlock).not.toContain('codex');
    expect(skillsBlock).not.toContain('cursor');
  });

  it('en 文案同样齐备：copy-failed 标签与无路径摘要（FU2 验收② en 半）', async () => {
    useAppStore.setState({ language: 'en' });
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') return Promise.resolve(dryRunResult());
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({ items: [], summary: { copy: 0, skip: 0 } });
      }
      if (action === 'externalImportSkillsApply') {
        return Promise.resolve({
          targetDir: '/tmp/data/skills',
          copied: 1,
          skipped: 1,
          items: [
            { sourceId: 'codex', name: 'alpha', action: 'copied' },
            {
              sourceId: 'cursor',
              name: 'broken-one',
              action: 'skipped',
              reason: 'copy-failed',
              error: "EACCES: permission denied, open '/tmp/data/skills/broken-one/SKILL.md'",
            },
          ],
        });
      }
      if (action === 'externalImportDetectSources') return Promise.resolve(detectResult());
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('Preview what will be imported'));
    await screen.findByTestId('external-import-preview');
    fireEvent.click(screen.getByText('Start import'));
    await screen.findByTestId('external-import-results');

    const skillsBlock = screen.getByTestId('external-import-results-skills').textContent ?? '';
    expect(skillsBlock).toContain('Skills: copied 1, skipped 1, placed in the Neo skills library');
    expect(skillsBlock).toContain('Copy failed; skipped');
    expect(skillsBlock).not.toContain('/tmp');
    expect(skillsBlock).not.toContain('EACCES');
  });

  it('「查看技能」打开能力中心技能页并关掉设置（FU2 验收③ UI 半）', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') return Promise.resolve(dryRunResult());
      if (action === 'externalImportSkillsPreview') {
        return Promise.resolve({ items: [], summary: { copy: 0, skip: 0 } });
      }
      if (action === 'externalImportSkillsApply') {
        return Promise.resolve({
          targetDir: '/tmp/data/skills',
          copied: 1,
          skipped: 0,
          items: [{ sourceId: 'codex', name: 'alpha', action: 'copied' }],
        });
      }
      if (action === 'externalImportDetectSources') return Promise.resolve(detectResult());
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByText('预览要导入的内容'));
    await screen.findByTestId('external-import-preview');
    fireEvent.click(screen.getByText('开始导入'));
    await screen.findByTestId('external-import-results');

    useAppStore.setState({ showSettings: true, showCapabilityHub: false, capabilityHubTab: 'experts' });
    fireEvent.click(screen.getByText('查看技能'));

    const state = useAppStore.getState();
    expect(state.showCapabilityHub).toBe(true);
    expect(state.capabilityHubTab).toBe('skills');
    expect(state.showSettings).toBe(false);
    // FU1：不再裸开 hub，而是带 external-import 深链焦（技能页内层落「已安装」且落页即清）
    expect(state.settingsCapabilityFocus).toMatchObject({ kind: 'skill', source: 'external-import' });
    useAppStore.setState({ settingsCapabilityFocus: null });
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

  it('预览头部计数 = 各分组「找到 N 条规则」之和：拆不出规则的整文件不计入（FU1 返修验收①）', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') {
        return Promise.resolve(dryRunResult({
          instructions: [
            {
              id: 'instruction:a',
              adapterId: 'codex-local-custom',
              title: 'AGENTS.md',
              content: '规则一',
              sourcePath: '~/.codex/AGENTS.md',
              reason: 'directive-confirmation-required',
              contentHash: 'ha',
              sourceMetadata: {},
            },
            {
              id: 'instruction:b',
              adapterId: 'codex-local-custom',
              title: 'AGENTS.md',
              content: '规则二',
              sourcePath: '~/.codex/AGENTS.md',
              reason: 'directive-confirmation-required',
              contentHash: 'hb',
              sourceMetadata: {},
            },
            {
              id: 'instruction:whole',
              adapterId: 'claude-code',
              title: 'CLAUDE.md',
              content: 'headings and code only',
              sourcePath: '~/.claude/CLAUDE.md',
              reason: 'instruction-file',
              contentHash: 'hwhole',
              sourceMetadata: { segmentCount: 0 },
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

    const headerCount = Number(
      screen.getByTestId('external-import-instructions').textContent?.match(/说明类内容（(\d+) 条）/)?.[1],
    );
    const groupCounts = screen.getAllByRole('button', { name: /找到 \d+ 条规则/ })
      .map((button) => Number(button.textContent?.match(/找到 (\d+) 条规则/)?.[1] ?? 0));
    expect(groupCounts).toEqual([2]);
    expect(headerCount).toBe(groupCounts.reduce((sum, count) => sum + count, 0));
    // 拆不出规则的用户级文件（segmentCount 0）仍占自己的一行，但不进头部数字
    expect(headerCount).not.toBe(3);
    expect(screen.getByTestId('external-import-rule-norules').textContent).toBe('没有可导入的单条规则');
  });

  it('只有项目级对照项时头部计 0 但区块仍渲染，对照行文案保留（FU1 返修验收①）', async () => {
    stubDetect(detectResult());
    render(<ExternalImportSettings />);
    await screen.findByTestId('external-import-sources');

    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'memoryHarnessImportDryRun') {
        return Promise.resolve(dryRunResult({
          instructions: [
            {
              id: 'instruction:project',
              adapterId: 'gemini-cli',
              title: 'GEMINI.md',
              content: 'project-level whole file',
              sourcePath: '~/work/repo/GEMINI.md',
              reason: 'instruction-file',
              contentHash: 'hproject',
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

    // 区块照常渲染（instructions.length > 0），头部只数可导入规则 → 0
    expect(screen.getByTestId('external-import-instructions').textContent)
      .toContain('说明类内容（0 条）');
    expect(screen.getByText('只供对照，不写入')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /找到 \d+ 条规则/ })).toBeNull();
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

    // K1A-FU1：规则分组默认收起，先展开再逐条导入
    fireEvent.click(screen.getByRole('button', { name: /找到 1 条规则/ }));
    // 返修钉子：确认钮不换行（nowrap + 不收缩），把换行让给规则原文
    const confirmButton = screen.getByText('导入这一条').closest('button');
    expect(confirmButton?.className).toContain('whitespace-nowrap');
    expect(confirmButton?.className).toContain('shrink-0');
    fireEvent.click(confirmButton as HTMLButtonElement);
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
    await screen.findByText('已导入');
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
