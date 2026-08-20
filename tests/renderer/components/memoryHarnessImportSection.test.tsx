// @vitest-environment jsdom
// ============================================================================
// V8 MemoryHarnessImportSection 首批 renderer 测试（盖 V3 前端半）：
// 1. dry-run 返回 skipped 时渲染被跳过来源，已知 reason 走 i18n、未知原样展示，
//    与「没有新的可导入记忆」空态可同时区分
// 2. instructions 超过 8 条时显示「还有 N 条未显示」
// ============================================================================

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MemoryImportDryRunResult } from '../../../src/shared/contract/memory';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain,
  },
}));

import { MemoryHarnessImportSection } from '../../../src/renderer/components/features/settings/tabs/MemoryHarnessImportSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function dryRunResult(overrides: Partial<MemoryImportDryRunResult> = {}): MemoryImportDryRunResult {
  return {
    scannedAdapters: ['codex-local-custom', 'claude-code', 'grok-build'],
    candidates: [],
    instructions: [],
    skipped: [],
    summary: {
      discoveredMemory: 0,
      readyToImport: 0,
      duplicates: 0,
      instructionOnly: 0,
      archived: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  invokeDomain.mockReset();
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

async function runPreview() {
  render(<MemoryHarnessImportSection />);
  fireEvent.click(screen.getByText('检测并预览'));
  await screen.findByTestId('harness-import-skipped');
}

describe('MemoryHarnessImportSection 导入预览诚实空态', () => {
  it('渲染 skipped 来源：已知 reason 翻 i18n、未知原样，空态文案同时可见', async () => {
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.MEMORY && action === 'memoryHarnessImportDryRun') {
        return Promise.resolve(dryRunResult({
          skipped: [
            { adapterId: 'grok-build', sourcePath: '~/.grok/memory', reason: 'source-not-found' },
            { adapterId: 'gemini-cli', sourcePath: '~/.gemini/memory', reason: 'adapter-crashed' },
          ],
        }));
      }
      return Promise.resolve(undefined);
    });

    await runPreview();

    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.MEMORY,
      'memoryHarnessImportDryRun',
      { action: 'memoryHarnessImportDryRun' },
    );
    const skipped = screen.getByTestId('harness-import-skipped');
    expect(skipped.textContent).toContain('已跳过 2 个来源');
    expect(skipped.textContent).toContain('未检测到该来源（未安装或目录不存在）');
    expect(skipped.textContent).toContain('adapter-crashed');
    // 空态与 skipped 可区分：没有可导入记忆 ≠ 来源不存在
    expect(screen.getByText('没有新的可导入记忆。')).toBeTruthy();
  });

  it('instructions 超过 8 条时显示剩余计数', async () => {
    const instructions = Array.from({ length: 10 }, (_, index) => ({
      id: `instr-${index}`,
      adapterId: 'claude-code' as const,
      title: `Rule ${index}`,
      content: `Rule content ${index}`,
      sourcePath: `~/rules/${index}.md`,
      reason: 'instruction-file' as const,
      contentHash: `hash-${index}`,
      sourceMetadata: {},
    }));
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.MEMORY && action === 'memoryHarnessImportDryRun') {
        return Promise.resolve(dryRunResult({
          instructions,
          summary: {
            discoveredMemory: 0,
            readyToImport: 0,
            duplicates: 0,
            instructionOnly: 10,
            archived: 0,
          },
        }));
      }
      return Promise.resolve(undefined);
    });

    render(<MemoryHarnessImportSection />);
    fireEvent.click(screen.getByText('检测并预览'));
    await screen.findByText('还有 2 条未显示');
  });
});
