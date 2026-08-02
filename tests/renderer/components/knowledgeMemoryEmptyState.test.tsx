// @vitest-environment jsdom
// ============================================================================
// 知识库「记忆审计」空态星球（2026-08-02 星球品牌升级）：默认空态 = 木星 +
// 「宝库等待第一颗珍藏」；筛选无结果仍是 Database 图标空态，不配星。
// ipcService 打桩拒绝 → loadAudit 走 catch（data=null、isLoading=false），
// 恰好落在空态分支；真实 IPC 形状由 knowledgeMemoryPanel.test.ts 覆盖。
// ============================================================================

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => {
  const ipc = {
    isAvailable: () => false,
    invoke: vi.fn(() => Promise.reject(new Error('test: no memory backend'))),
    invokeDomain: vi.fn(() => Promise.reject(new Error('test: no memory backend'))),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { default: ipc, ipcService: ipc };
});

import { KnowledgeMemoryContent } from '../../../src/renderer/components/features/knowledge/KnowledgeMemoryPanel';

describe('KnowledgeMemoryPanel 记忆审计空态星球', () => {
  afterEach(() => cleanup());

  it('默认空态渲染木星 +「宝库等待第一颗珍藏」', async () => {
    const { container } = render(<KnowledgeMemoryContent />);
    await waitFor(() => {
      expect(screen.getByText('宝库等待第一颗珍藏')).toBeTruthy();
    });
    expect(container.querySelector('[data-planet="jupiter"]')).toBeTruthy();
  });
});
