// @vitest-environment jsdom
// ============================================================================
// PR #2361 rework 回归：skill caution「待确认」信封必须穿过**真** HTTP transport。
// host（skill.ipc.ts 的 catch → error.result，domain 兜底路由原样 sendJson）把
// 未签名来源的 caution 门回报为 HTTP 200 + {success:false,
// code:'SKILL_CAUTION_CONFIRMATION_REQUIRED', cautionHits, confirmationToken}；
// httpTransport 通用解包曾把 success:false 一律坍缩成 undefined 并记 transport
// failure，实机上确认页永远打不开。这里只 mock fetch：wire JSON 由真 gate
// （applySkillCautionGate）产出，transport / invokeSkillIPCOrThrow / ipcService /
// installLocalSkillZip / SkillsSettings 全是真码。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { SKILL_CHANNELS } from '../../../src/shared/ipc/channels';

// 真 gate 模块顶层的 createLogger 会拖进 host 文件日志 sink：桩掉（gate 的
// throw 路径只用 logger.warn，桩实现足够）
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (
    selector: (state: { settingsCapabilityFocus: null; clearSettingsCapabilityFocus: () => void }) => unknown,
  ) =>
    selector({
      settingsCapabilityFocus: null,
      clearSettingsCapabilityFocus: () => undefined,
    }),
}));

// 本地 ZIP 走原生文件选择（非 web 模式），桩掉文件对话框
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  pickNativeFile: vi.fn().mockResolvedValue('/tmp/caution.zip'),
  saveNativeFile: vi.fn(),
}));

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { applySkillCautionGate } from '../../../src/host/skills/marketplace/skillInstallCautionGate';
import { installLocalSkillZip } from '../../../src/renderer/services/skillLocalZip';
import { isSkillCautionConfirmationRequired } from '../../../src/renderer/services/skillInstallCaution';
import { SkillsSettings } from '../../../src/renderer/components/features/settings/tabs/SkillsSettings';

const cautionText = zh.settings.skills.caution;
const LOCAL_ZIP_URL = 'http://localhost:8180/api/skill/install/local-zip';

/** 真 gate 产出真 wire JSON：确认门开着（env flag）+ 不带 token → 必然 throw */
async function realConfirmationRequiredJson() {
  const cautionHits = [
    { file: 'demo/SKILL.md', ruleId: 'recursive_delete_targeted', snippet: 'rm -rf ./dist' },
  ];
  const previous = process.env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED;
  process.env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED = '1';
  try {
    await applySkillCautionGate({
      pluginSpec: 'demo@local-zip',
      sourceTrust: 'local-marketplace',
      contentHash: 'a'.repeat(64),
      cautionHits,
    });
    throw new Error('gate did not require confirmation — test premise broken');
  } catch (error) {
    if (error instanceof Error && error.message.includes('test premise broken')) throw error;
    // skill.ipc.ts 的 catch 语义：return error.result —— 这就是 HTTP body
    const result = (error as { result?: unknown }).result as Record<string, unknown> | undefined;
    expect(result).toMatchObject({ success: false, code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED' });
    return result as unknown;
  } finally {
    if (previous === undefined) delete process.env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED;
    else process.env.CODE_AGENT_SKILL_CAUTION_CONFIRMATION_ENABLED = previous;
  }
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
    text: async () => '',
  };
}

/** 按路径路由的 fetch 桩：local-zip 吃队列，其余按设置页挂载期的通道回默认载荷。
 * 注意不能从路径反推 channel（`skill:repo:list` → `/api/skill/repo/list` 的冒号
 * 不对称），直接按 channelToEndpoint 的产物路径分发。 */
function setupFetch(zipBodies: unknown[]) {
  const queue = [...zipBodies];
  // 第二参 init 声明出来：localZipCalls 要按元组取 body 断言重发 payload
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/skill/install/local-zip') {
      return jsonResponse(queue.shift() ?? { success: true, skillName: 'demo' });
    }
    switch (path) {
      case '/api/skill/repo/list':        // skill:repo:list
      case '/api/skill/list':             // skill:list
      case '/api/skill/recommended-repos':
        return jsonResponse([]);
      case '/api/skill/catalog':
        return jsonResponse({ categories: [], skills: [], bundles: [], repositories: [] });
      case '/api/skill/registry/list':
        return jsonResponse({ items: [] });
      default:
        return jsonResponse({ success: true });
    }
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function localZipCalls(fetchMock: ReturnType<typeof setupFetch>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === LOCAL_ZIP_URL)
    .map(([, init]) => JSON.parse(String(init?.body)));
}

describe('httpTransport keeps the skill caution confirmation envelope intact', () => {
  const originalFetch = globalThis.fetch;

  // 注意不能设置 window.__CODE_AGENT_TOKEN__：它同时是 isWebMode() 的运行时判据，
  // 设了会把「从 ZIP 安装」拐进 web 文件选择器而非（已桩的）原生对话框
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    window.codeAgentAPI = undefined;
  });

  it('a confirmation-required answer (200 + success:false + code) survives the transport', async () => {
    const wireJson = await realConfirmationRequiredJson();
    expect(wireJson).toMatchObject({ success: false, code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED' });
    const fetchMock = setupFetch([wireJson]);
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await api.invoke(SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP, { zipPath: '/tmp/caution.zip' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 信封必须活着到达 renderer（坍缩成 undefined 就是 PR #2361 实机撞到的洞）
    expect(result).toEqual(wireJson);
    expect(isSkillCautionConfirmationRequired(result)).toBe(true);
  });

  it('installLocalSkillZip resolves to the confirmation-required object through the real transport', async () => {
    const wireJson = await realConfirmationRequiredJson();
    setupFetch([wireJson]);
    window.codeAgentAPI = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await installLocalSkillZip({ zipPath: '/tmp/caution.zip' });

    // OrThrow 也不得把它当 transport failure 抛掉：调用页靠判别分流弹确认面
    expect(isSkillCautionConfirmationRequired(result)).toBe(true);
    expect(result).toEqual(wireJson);
  });

  it('a plain {success:false, error} answer still collapses (generic unwrap unchanged)', async () => {
    setupFetch([{ success: false, error: 'boom' }]);
    window.codeAgentAPI = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await installLocalSkillZip({ zipPath: '/tmp/caution.zip' });

    expect(isSkillCautionConfirmationRequired(result)).toBe(false);
    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('SkillsSettings opens the modal with the hits; cancel sends no second install call, confirm re-invokes with the token', async () => {
    const wireJson = await realConfirmationRequiredJson();
    const required = isSkillCautionConfirmationRequired(wireJson) ? wireJson : undefined;
    expect(required).toBeTruthy();
    const fetchMock = setupFetch([wireJson, wireJson, { success: true, skillName: 'demo' }]);
    window.codeAgentAPI = createHttpCodeAgentAPI('http://localhost:8180');

    render(<SkillsSettings />);
    fireEvent.click(await screen.findByRole('tab', { name: /已安装/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: zh.settings.skills.installed.installFromZipAria }),
    );

    // 确认面带着真 gate 的命中打开（正文一句白话 + 运行时审批真相按命中裁剪：
    // 只命中 rm -rf → 强确认档句在，其余档句不在；rule id + snippet 折在明细）
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    expect(screen.getByText('demo@local-zip')).toBeTruthy();
    expect(screen.getByText(cautionText.rules.recursive_delete_targeted)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.lead)).toBeTruthy();
    expect(screen.getByText(cautionText.runtimeApproval.forcedConfirm)).toBeTruthy();
    expect(screen.queryByText(cautionText.runtimeApproval.askByDefault)).toBeNull();
    expect(screen.queryByText(cautionText.runtimeApproval.readOnly)).toBeNull();
    expect(screen.queryByText(cautionText.runtimeApproval.hardDeny)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: cautionText.detailsShow }));
    expect(screen.getByText('recursive_delete_targeted')).toBeTruthy();
    expect(screen.getByText('rm -rf ./dist')).toBeTruthy();
    expect(localZipCalls(fetchMock)).toEqual([{ zipPath: '/tmp/caution.zip' }]);

    // 取消：不安装（无第二次 install 调用），弹窗关闭
    fireEvent.click(screen.getByRole('button', { name: zh.common.cancel }));
    await waitFor(() => expect(screen.queryByText(cautionText.title)).toBeNull(), { timeout: 5000 });
    expect(localZipCalls(fetchMock)).toEqual([{ zipPath: '/tmp/caution.zip' }]);

    // 重新发起安装，这次确认：携真 token 原样重发 → 成功提示
    fireEvent.click(await screen.findByRole('button', { name: zh.settings.skills.installed.installFromZipAria }));
    expect(await screen.findByText(cautionText.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: cautionText.confirmInstall }));
    await screen.findByText(/已安装 demo/);
    await waitFor(
      () => expect(screen.queryByText(cautionText.title)).toBeNull(),
      { timeout: 5000 },
    );
    expect(localZipCalls(fetchMock)).toEqual([
      { zipPath: '/tmp/caution.zip' },
      { zipPath: '/tmp/caution.zip' },
      { zipPath: '/tmp/caution.zip', cautionConfirmationToken: required!.confirmationToken },
    ]);
  });
});
