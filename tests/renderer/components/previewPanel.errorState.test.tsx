// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewErrorState, toPreviewErrorState } from '../../../src/renderer/components/PreviewPanel';
import { ArtifactStandingRefresh } from '../../../src/renderer/components/ArtifactStandingRefresh';
import { buildStandingRefreshJobInput } from '@shared/artifactStandingRefresh';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}


const domainInvoke = vi.hoisted(() => vi.fn());
const cronCalls = vi.hoisted(() => ({
  createJob: vi.fn().mockResolvedValue({ id: 'job-new' }),
  updateJob: vi.fn().mockResolvedValue({ id: 'job-existing' }),
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({ cronClient: cronCalls }));

function publishInfoResponse(data: Record<string, unknown>) {
  return { success: true, data };
}

function mockPublishInfo(standingRefresh?: Record<string, unknown>) {
  domainInvoke.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'getPublishInfo') {
      return publishInfoResponse({
        publishState: { kind: 'draft' },
        publishedVersions: [],
        ...(standingRefresh ? { standingRefresh } : {}),
      });
    }
    throw new Error(`unexpected workspace action: ${action}`);
  });
}

beforeEach(() => {
  (window as unknown as { domainAPI: unknown }).domainAPI = { invoke: domainInvoke };
  mockPublishInfo();
});

afterEach(() => {
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  domainInvoke.mockReset();
  cronCalls.createJob.mockClear();
  cronCalls.updateJob.mockClear();
  cleanup();
});

// 原 bug 形状：loadContent/handleSave 的 catch 块把三元表达式写反了——
// `err instanceof Error ? err.message : pv.xxxFailed`，导致最常见的 Error
// 实例分支反而裸露原始异常文本，只有非 Error 的冷门分支才走人话 fallback。
// toPreviewErrorState 把这个决策收口成一个函数：message 永远是调用方传入
// 的人话 fallback，不管 err 是不是 Error 实例；detail 才装原始文本。
describe('toPreviewErrorState — message 永远人话，detail 才装原始异常文本', () => {
  it('Error 实例：message 仍是人话 fallback，不是 err.message', () => {
    const err = new Error("ENOENT: no such file or directory, open '/tmp/x.md'");
    const result = toPreviewErrorState(err, '加载文件失败');
    expect(result.message).toBe('加载文件失败');
    expect(result.detail).toBe("ENOENT: no such file or directory, open '/tmp/x.md'");
  });

  it('非 Error 拒绝值：message 依旧是人话 fallback，detail 兜底转字符串', () => {
    const result = toPreviewErrorState('raw string rejection', '保存失败');
    expect(result.message).toBe('保存失败');
    expect(result.detail).toBe('raw string rejection');
  });
});

// PreviewPanel 加载/保存失败此前把 IPC 原始报错（invokeWorkspace 抛出的
// response.error.message，通常是英文异常文本）直接当 error 状态渲染。现在
// error 永远是人话摘要（loadFileFailed/saveFailed 等既有键），原始文本只
// 挂进 title tooltip——回归钉子：断言原始 detail 文本不会作为可见文本节点
// 出现，只能出现在 title="..." 属性里。
describe('PreviewErrorState — 加载/保存失败人话化', () => {
  it('展示人话摘要，原始错误文本只进 title tooltip 不裸露成可见文案', () => {
    const raw = "ENOENT: no such file or directory, open '/Users/x/broken.md'";
    const html = renderToStaticMarkup(
      <PreviewErrorState message="加载文件失败" detail={raw} onRetry={vi.fn()} />,
    );

    expect(html).toContain('加载文件失败');
    expect(html).toContain(`title="${raw.replace(/'/g, '&#x27;')}"`);
    // 原文只应该出现一次——即 title 属性里那一次，可见文本节点里不能再出现一遍
    const visibleText = html.replace(/title="[^"]*"/, '');
    expect(visibleText).not.toContain(raw);
  });

  it('没有 detail 时不渲染 title 属性', () => {
    const html = renderToStaticMarkup(
      <PreviewErrorState message="保存失败" onRetry={vi.fn()} />,
    );

    expect(html).toContain('保存失败');
    expect(html).not.toContain('title=');
  });
});

// 接线钉子：只单测 toPreviewErrorState/PreviewErrorState 本身，钉不住调用点是否
// 真的接了它们——把 loadContent/handleSave 的 catch 块改回旧 bug 形状
// （`setErrorState(err instanceof Error ? err.message : pv.xxxFailed)`）不会让
// 上面两个 describe 变红。读源文件断言调用点真实形状（先例：mainTaskModelCopy.test.ts）。
describe('PreviewPanel 接线钉子 — catch 块真的走 toPreviewErrorState', () => {
  it('loadContent/handleSave 的 catch 调用 toPreviewErrorState，不退回把 err.message 直接当主文案的旧形状', () => {
    const source = readSource('src/renderer/components/PreviewPanel.tsx');

    expect(source).toContain('toPreviewErrorState(err, pv.loadFileFailed)');
    expect(source).toContain('toPreviewErrorState(err, pv.saveFailed)');
    expect(source).not.toContain('err instanceof Error ? err.message : pv.loadFileFailed');
    expect(source).not.toContain('err instanceof Error ? err.message : pv.saveFailed');
  });
});

describe('PreviewPanel 文件头收敛', () => {
  it('路径置顶且可复制，直接动作只留外部打开与更多，底部路径栏已删除', () => {
    const source = readSource('src/renderer/components/PreviewPanel.tsx');
    const header = source.slice(
      source.indexOf('{/* Single header:'),
      source.indexOf('{/* Content */}'),
    );

    expect(header).toContain('aria-label={pv.copyPath}');
    expect(header).toContain('title={previewFilePath ?? activeTab.title}');
    expect(header.match(/<ExternalLink/g)).toHaveLength(1);
    expect(header.match(/<MoreHorizontal/g)).toHaveLength(1);
    expect(source).not.toContain('Footer - File path');
  });
});

describe('ArtifactStandingRefresh 弹窗保存', () => {
  it('无既有任务：保存调 createJob，payload 等于 buildStandingRefreshJobInput 的输出', async () => {
    render(<ArtifactStandingRefresh filePath="/tmp/wt/weekly-report.json" />);
    await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));

    fireEvent.click(screen.getByTestId('artifact-standing-refresh-chip'));
    const textarea = await screen.findByPlaceholderText(/汇总本周进展/);
    fireEvent.change(textarea, { target: { value: 'Refresh weekly numbers' } });
    fireEvent.click(screen.getByText('每周'));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(cronCalls.createJob).toHaveBeenCalledTimes(1));
    expect(cronCalls.updateJob).not.toHaveBeenCalled();
    const input = cronCalls.createJob.mock.calls[0][0];
    expect(input).toEqual(
      buildStandingRefreshJobInput(
        { path: '/tmp/wt/weekly-report.json', instruction: 'Refresh weekly numbers', cadence: 'weekly' },
        '/tmp/wt',
      ),
    );
    // 关键字段直接核一遍，读测试不需要反推 builder
    expect(input.metadata.artifactRefresh.path).toBe('/tmp/wt/weekly-report.json');
    expect(input.schedule).toEqual({ type: 'cron', expression: '0 9 * * 1' });
    expect(input.tags).toContain('artifact-refresh');
  });

  it('已有任务（standingRefresh.jobId）：保存改走 updateJob 并带回原 jobId', async () => {
    mockPublishInfo({
      jobId: 'job-existing',
      enabled: true,
      cadence: 'daily',
      instruction: '旧指令',
      lastRunAt: 111,
    });
    render(<ArtifactStandingRefresh filePath="/tmp/wt/weekly-report.json" />);
    await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));

    fireEvent.click(screen.getByTestId('artifact-standing-refresh-chip'));
    // 编辑态回填旧指令
    await waitFor(() => screen.getByDisplayValue('旧指令'));
    fireEvent.change(screen.getByDisplayValue('旧指令'), { target: { value: '新指令' } });
    fireEvent.click(screen.getByText('每小时'));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(cronCalls.updateJob).toHaveBeenCalledTimes(1));
    expect(cronCalls.createJob).not.toHaveBeenCalled();
    expect(cronCalls.updateJob.mock.calls[0][0]).toBe('job-existing');
    expect(cronCalls.updateJob.mock.calls[0][1].metadata.artifactRefresh).toMatchObject({
      path: '/tmp/wt/weekly-report.json',
      instruction: '新指令',
      cadence: 'hourly',
    });
  });

  it('保存失败：显示人话错误，不抛原始 IPC 文本', async () => {
    cronCalls.createJob.mockRejectedValueOnce(new Error('IPC blew up with raw stack'));
    render(<ArtifactStandingRefresh filePath="/tmp/wt/weekly-report.json" />);
    await waitFor(() => screen.getByTestId('artifact-standing-refresh-chip'));

    fireEvent.click(screen.getByTestId('artifact-standing-refresh-chip'));
    fireEvent.change(await screen.findByPlaceholderText(/汇总本周进展/), { target: { value: 'do it' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => screen.getByTestId('standing-refresh-save-error'));
    expect(screen.getByTestId('standing-refresh-save-error').textContent).not.toContain('IPC blew up');
  });
});

describe('ArtifactStandingRefresh chip 状态', () => {
  it('无任务时是设置入口；有任务时显示节奏', async () => {
    const { unmount } = render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);
    await waitFor(() => expect(screen.getByTestId('artifact-standing-refresh-chip').textContent).toContain('设置自动更新'));
    unmount();

    mockPublishInfo({ jobId: 'job-1', enabled: true, cadence: 'daily', instruction: 'x' });
    render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);
    await waitFor(() => expect(screen.getByTestId('artifact-standing-refresh-chip').textContent).toContain('自动更新'));
    expect(screen.getByTestId('artifact-standing-refresh-chip').textContent).toContain('每天');
  });

  it('lastRefreshFailed 在场：chip 只显示短状态「已保留上一版」，时间/原因进 title，label 无 truncate', async () => {
    const at = Date.UTC(2026, 9, 4, 1, 2, 3);
    mockPublishInfo({
      jobId: 'job-1',
      enabled: true,
      cadence: 'daily',
      instruction: 'x',
      lastRefreshFailed: { at, reason: 'agent run failed: boom' },
    });
    render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);

    // 等 failure 态渲染出来（初始是 setup 态）
    const chip = await waitFor(() => {
      const el = screen.getByTestId('artifact-standing-refresh-chip');
      expect(el.textContent).toContain('更新失败·已保留上一版');
      return el;
    });
    // 「已保留上一版」常显完整：失败 label 元素不得带 truncate（textContent 断言
    // 抓不住视觉截断，旧形状长标签 + truncate 会把它截成「已…」只剩 hover 可见）
    const label = chip.querySelector('span');
    expect(label).not.toBeNull();
    expect(label?.className).not.toContain('truncate');
    // 失败态 chip 本身也不设 max-w 上限，短状态任何宽度都放得下
    expect(chip.className).not.toContain('max-w-');
    // 可见文案不含时间（旧形状把时间塞进 label 后被截断）
    expect(chip.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    // 原因属工程细节：进 tooltip，不进可见文案
    expect(chip.textContent).not.toContain('boom');
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('boom');
    // 时间按 app 语言（zh→zh-CN）格式化，不是浏览器默认 locale（本机默认 en-US）
    expect(title).toContain(new Date(at).toLocaleString('zh-CN'));
    expect(title).not.toMatch(/\b[AP]M\b/);
  });

  it('en 语言：失败 chip 是英文短状态，title 用 en-US 格式化时间', async () => {
    const at = Date.UTC(2026, 9, 4, 1, 2, 3);
    mockPublishInfo({
      jobId: 'job-1',
      enabled: true,
      cadence: 'daily',
      instruction: 'x',
      lastRefreshFailed: { at, reason: 'agent run failed: boom' },
    });
    useAppStore.getState().setLanguage('en');
    try {
      render(<ArtifactStandingRefresh filePath="/tmp/wt/a.json" />);

      const chip = await waitFor(() => {
        const el = screen.getByTestId('artifact-standing-refresh-chip');
        expect(el.textContent).toContain('Refresh failed · previous version kept');
        return el;
      });
      expect(chip.textContent).not.toMatch(/\d{1,2}:\d{2}/);
      const label = chip.querySelector('span');
      expect(label?.className).not.toContain('truncate');
      const title = chip.getAttribute('title') ?? '';
      expect(title).toContain(new Date(at).toLocaleString('en-US'));
    } finally {
      useAppStore.getState().setLanguage('zh');
    }
  });
});
